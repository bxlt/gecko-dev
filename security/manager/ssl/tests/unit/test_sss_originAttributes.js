/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * vim: sw=2 ts=2 sts=2
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Ensures nsISiteSecurityService APIs respects origin attributes.

registerCleanupFunction(() => {
  Services.prefs.clearUserPref("security.cert_pinning.enforcement_level");
  Services.prefs.clearUserPref(
    "security.cert_pinning.process_headers_from_non_builtin_roots"
  );
});

const GOOD_MAX_AGE_SECONDS = 69403;
const NON_ISSUED_KEY_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PINNING_ROOT_KEY_HASH = "VCIlmPM9NkgFQtrs4Oa5TeFcDu6MWRTKSNdePEhOgD8=";
const VALID_PIN = `pin-sha256="${PINNING_ROOT_KEY_HASH}";`;
const BACKUP_PIN = `pin-sha256="${NON_ISSUED_KEY_HASH}";`;
const GOOD_MAX_AGE = `max-age=${GOOD_MAX_AGE_SECONDS};`;

do_get_profile(); // must be done before instantiating nsIX509CertDB

Services.prefs.setIntPref("security.cert_pinning.enforcement_level", 2);
Services.prefs.setBoolPref(
  "security.cert_pinning.process_headers_from_non_builtin_roots",
  true
);

let sss = Cc["@mozilla.org/ssservice;1"].getService(Ci.nsISiteSecurityService);
let host = "a.pinning.example.com";
let uri = Services.io.newURI("https://" + host);

// Check if originAttributes1 and originAttributes2 are isolated with respect
// to HSTS/HPKP storage.
function doTest(secInfo, originAttributes1, originAttributes2, shouldShare) {
  sss.clearAll();
  for (let type of [
    Ci.nsISiteSecurityService.HEADER_HSTS,
    Ci.nsISiteSecurityService.HEADER_HPKP,
  ]) {
    let header = GOOD_MAX_AGE;
    if (type == Ci.nsISiteSecurityService.HEADER_HPKP) {
      header += VALID_PIN + BACKUP_PIN;
    }
    // Set HSTS or HPKP for originAttributes1.
    sss.processHeader(
      type,
      uri,
      header,
      secInfo,
      0,
      Ci.nsISiteSecurityService.SOURCE_ORGANIC_REQUEST,
      originAttributes1
    );
    ok(
      sss.isSecureURI(type, uri, 0, originAttributes1),
      "URI should be secure given original origin attributes"
    );
    equal(
      sss.isSecureURI(type, uri, 0, originAttributes2),
      shouldShare,
      "URI should be secure given different origin attributes if and " +
        "only if shouldShare is true"
    );

    if (!shouldShare) {
      // Remove originAttributes2 from the storage.
      sss.resetState(type, uri, 0, originAttributes2);
      ok(
        sss.isSecureURI(type, uri, 0, originAttributes1),
        "URI should still be secure given original origin attributes"
      );
    }

    // Remove originAttributes1 from the storage.
    sss.resetState(type, uri, 0, originAttributes1);
    ok(
      !sss.isSecureURI(type, uri, 0, originAttributes1),
      "URI should be not be secure after removeState"
    );
  }
  // Set HPKP for originAttributes1.
  sss.setKeyPins(
    host,
    false,
    Date.now() + 1234567890,
    [NON_ISSUED_KEY_HASH, PINNING_ROOT_KEY_HASH],
    false,
    originAttributes1
  );
  ok(
    sss.isSecureURI(
      Ci.nsISiteSecurityService.HEADER_HPKP,
      uri,
      0,
      originAttributes1
    ),
    "URI should be secure after setKeyPins given original origin attributes"
  );
  equal(
    sss.isSecureURI(
      Ci.nsISiteSecurityService.HEADER_HPKP,
      uri,
      0,
      originAttributes2
    ),
    shouldShare,
    "URI should be secure after setKeyPins given different " +
      "origin attributes if and only if shouldShare is true"
  );

  sss.clearAll();
  ok(
    !sss.isSecureURI(
      Ci.nsISiteSecurityService.HEADER_HPKP,
      uri,
      0,
      originAttributes1
    ),
    "URI should not be secure after clearAll"
  );
}

function testInvalidOriginAttributes(secInfo, originAttributes) {
  for (let type of [
    Ci.nsISiteSecurityService.HEADER_HSTS,
    Ci.nsISiteSecurityService.HEADER_HPKP,
  ]) {
    let header = GOOD_MAX_AGE;
    if (type == Ci.nsISiteSecurityService.HEADER_HPKP) {
      header += VALID_PIN + BACKUP_PIN;
    }

    let callbacks = [
      () =>
        sss.processHeader(
          type,
          uri,
          header,
          secInfo,
          0,
          Ci.nsISiteSecurityService.SOURCE_ORGANIC_REQUEST,
          originAttributes
        ),
      () => sss.isSecureURI(type, uri, 0, originAttributes),
      () => sss.resetState(type, uri, 0, originAttributes),
    ];

    for (let callback of callbacks) {
      throws(
        callback,
        /NS_ERROR_ILLEGAL_VALUE/,
        "Should get an error with invalid origin attributes"
      );
    }
  }

  throws(
    () =>
      sss.setKeyPins(
        host,
        false,
        Date.now() + 1234567890,
        [NON_ISSUED_KEY_HASH, PINNING_ROOT_KEY_HASH],
        false,
        originAttributes
      ),
    /NS_ERROR_ILLEGAL_VALUE/,
    "Should get an error with invalid origin attributes"
  );
}

function add_tests() {
  sss.clearAll();

  let secInfo = null;
  add_connection_test(
    "a.pinning.example.com",
    PRErrorCodeSuccess,
    undefined,
    aSecInfo => {
      secInfo = aSecInfo;
    }
  );

  add_task(function() {
    let originAttributesList = [];
    for (let userContextId of [0, 1, 2]) {
      for (let firstPartyDomain of ["", "foo.com", "bar.com"]) {
        originAttributesList.push({ userContextId, firstPartyDomain });
      }
    }
    for (let attrs1 of originAttributesList) {
      for (let attrs2 of originAttributesList) {
        // SSS storage is not isolated by userContext
        doTest(
          secInfo,
          attrs1,
          attrs2,
          attrs1.firstPartyDomain == attrs2.firstPartyDomain
        );
      }
    }

    testInvalidOriginAttributes(secInfo, undefined);
    testInvalidOriginAttributes(secInfo, null);
    testInvalidOriginAttributes(secInfo, 1);
    testInvalidOriginAttributes(secInfo, "foo");
  });
}

function run_test() {
  add_tls_server_setup("BadCertAndPinningServer", "bad_certs");

  add_tests();

  run_next_test();
}
