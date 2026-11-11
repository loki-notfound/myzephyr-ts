/**
 * Daemon endpoints of the network tests, read from the runner's environment; the test sources name
 * no daemon host.
 *
 *   ZEPHYR_TS_TEST_DAEMON          address of a daemon reached directly: http(s)://host:port, no path
 *   ZEPHYR_TS_TEST_DAEMON_HTTPS    optional https address of a daemon that serves the same chain (it
 *                                  may be the same daemon behind a TLS proxy); used by check N03, the
 *                                  TLS sync and the comparison of binary answers. Without it N03 is
 *                                  reported as not run and the suite exits with status 3.
 *   ZEPHYR_TS_TEST_FORWARD_UPSTREAM  optional upstream of the loopback forwarder used by the browser
 *                                  run and the base-path forms; one of the two addresses above
 *                                  (default ZEPHYR_TS_TEST_DAEMON)
 *
 * The tests contact only these daemons and test-owned listeners on 127.0.0.1, read-only. A missing
 * required value or a malformed value stops the run with a message that names the variable.
 */
"use strict";

class EndpointConfigError extends Error {}

function parse(name, value, httpsOnly) {
  if (value === undefined || value === "") throw new EndpointConfigError(name + " is not set");
  let u;
  try { u = new URL(value); } catch (e) { throw new EndpointConfigError(name + " is not a URL"); }
  if (u.protocol !== "https:" && (httpsOnly || u.protocol !== "http:")) throw new EndpointConfigError(name + " must use " + (httpsOnly ? "https" : "http or https"));
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw new EndpointConfigError(name + " must be scheme, host and optional port only");
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  return { name, url: u.origin, host: u.hostname.replace(/^\[|\]$/g, ""), port };
}

/** The configured endpoints; throws EndpointConfigError when the configuration is incomplete. */
function loadTestEndpoints(env) {
  const e = env || process.env;
  const direct = parse("ZEPHYR_TS_TEST_DAEMON", e.ZEPHYR_TS_TEST_DAEMON, false);
  const tls = e.ZEPHYR_TS_TEST_DAEMON_HTTPS === undefined || e.ZEPHYR_TS_TEST_DAEMON_HTTPS === "" ? undefined : parse("ZEPHYR_TS_TEST_DAEMON_HTTPS", e.ZEPHYR_TS_TEST_DAEMON_HTTPS, true);
  const upstream = e.ZEPHYR_TS_TEST_FORWARD_UPSTREAM ? parse("ZEPHYR_TS_TEST_FORWARD_UPSTREAM", e.ZEPHYR_TS_TEST_FORWARD_UPSTREAM, false) : direct;
  if (upstream.url !== direct.url && (tls === undefined || upstream.url !== tls.url)) throw new EndpointConfigError("ZEPHYR_TS_TEST_FORWARD_UPSTREAM must equal ZEPHYR_TS_TEST_DAEMON or ZEPHYR_TS_TEST_DAEMON_HTTPS");
  return { direct, tls, upstream, all: tls === undefined ? [direct] : [direct, tls] };
}

/** Exit with status 2 and a clear message when the configuration is incomplete. */
function requireTestEndpoints(env) {
  try {
    return loadTestEndpoints(env);
  } catch (err) {
    if (!(err instanceof EndpointConfigError)) throw err;
    process.stderr.write("network test configuration: " + err.message + "\n"
      + "Set ZEPHYR_TS_TEST_DAEMON (http(s)://host:port of a daemon you may query) and optionally ZEPHYR_TS_TEST_DAEMON_HTTPS\n"
      + "(https://host[:port] of a daemon on the same chain); see BUILDING.md, section Network tests.\n");
    process.exit(2);
  }
}

module.exports = { loadTestEndpoints, requireTestEndpoints, EndpointConfigError };
