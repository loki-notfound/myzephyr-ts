#include <emscripten.h>
#include <emscripten/fetch.h>
#include <iostream>
#include <algorithm>
#include <cctype>
#include "http_client_wasm.h"
#include <boost/property_tree/ptree.hpp>
#include <boost/property_tree/json_parser.hpp>
#include "string_tools.h"
#include "misc_log_ex.h"
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "rapidjson/document.h"

using namespace std;

// The JavaScript transport. Each request is bounded by timeout_ms (the core's timeout
// for the call, capped by the bridge, see effective_timeout_ms) and cancelled when it expires. A
// failed request reports only {"error":"transport"}: no error text, URI, header or body of a
// failed request is copied into the module. A response reports its status code, headers and body
// for the core to parse; the status text supplied by the server is not copied.
EM_JS(const char*, js_send_json_request, (int client, const char* uri, const char* username, const char* password, const char* proxy_uri, const char* reject_unauthorized_fn_id, const char* method, const char* body, int timeout_ms, const char* relay_scope), {
  const HttpClient = this.HttpClient;
  const LibraryUtils = this.LibraryUtils;

  // use asyncify to synchronously return to C++
  return Asyncify.handleSleep(function(wakeUp) {

    // register cancellation before starting the request
    const cancellation = HttpClient.createCancelToken();
    if (!Module.httpRequestCancels) Module.httpRequestCancels = {};
    Module.httpRequestCancels[client] = cancellation.cancel;
    let wakeUpCalled = false;
    const finish = function(str) {
      if (wakeUpCalled) return; // a late settlement after a timeout or cancellation is ignored
      wakeUpCalled = true;
      clearTimeout(timer);
      if (Module.httpRequestCancels[client] === cancellation.cancel) delete Module.httpRequestCancels[client];
      let lengthBytes = Module.lengthBytesUTF8(str) + 1;
      let ptr = Module._malloc(lengthBytes);
      Module.stringToUTF8(str, ptr, lengthBytes);
      wakeUp(ptr);
    };
    // a failed request reports its stage: "refused" (the SDK's transport refused it before sending: its error is a
    // ZephyrWalletError), "connection" (the connection was refused, so nothing was sent: the cause's fixed code
    // ECONNREFUSED in Node.js) or "sent" (anything else, including a timeout: an answer may have been lost). Only the
    // error's name and its cause's code are compared; no text of the error is read
    const stageOf = function(err) {
      if (err && err.name === "ZephyrWalletError") return "refused";
      if (err && err.cause && err.cause.code === "ECONNREFUSED") return "connection";
      return "sent";
    };
    const timer = setTimeout(function() { cancellation.cancel(); finish(JSON.stringify({error: "transport", stage: "sent"})); }, timeout_ms);

    // make request and process response or error
    let request;
    try {
      request = HttpClient.request({
        method: UTF8ToString(method),
        uri: UTF8ToString(uri),
        username: UTF8ToString(username),
        password: UTF8ToString(password),
        body: UTF8ToString(body),
        proxyUri: UTF8ToString(proxy_uri) || undefined,
        relayScope: UTF8ToString(relay_scope) || undefined,
        cancelToken: cancellation.token,
        resolveWithFullResponse: true,
        rejectUnauthorized: LibraryUtils.isRejectUnauthorized(UTF8ToString(reject_unauthorized_fn_id)),
      });
    } catch (err) {
      request = Promise.reject(err);
    }
    request.then(resp => {
      finish(JSON.stringify({code: resp.statusCode, message: "", body: typeof resp.body === "string" ? resp.body : "", headers: resp.headers || {}}));
    }).catch(err => {
      finish(JSON.stringify({error: "transport", stage: stageOf(err)})); // the error's text is not read
    });
  });
});

EM_JS(const char*, js_send_binary_request, (int client, const char* uri, const char* username, const char* password, const char* proxy_uri, const char* reject_unauthorized_fn_id, const char* method, const char* body, int body_length, int timeout_ms), {
  const HttpClient = this.HttpClient;
  const LibraryUtils = this.LibraryUtils;

  // use asyncify to synchronously return to C++
  return Asyncify.handleSleep(function(wakeUp) {

    // register cancellation before starting the request
    const cancellation = HttpClient.createCancelToken();
    if (!Module.httpRequestCancels) Module.httpRequestCancels = {};
    Module.httpRequestCancels[client] = cancellation.cancel;
    let wakeUpCalled = false;
    const finish = function(str) {
      if (wakeUpCalled) return; // a late settlement after a timeout or cancellation is ignored
      wakeUpCalled = true;
      clearTimeout(timer);
      if (Module.httpRequestCancels[client] === cancellation.cancel) delete Module.httpRequestCancels[client];
      let lengthBytes = Module.lengthBytesUTF8(str) + 1;
      let ptr = Module._malloc(lengthBytes);
      Module.stringToUTF8(str, ptr, lengthBytes);
      wakeUp(ptr);
    };
    const timer = setTimeout(function() { cancellation.cancel(); finish(JSON.stringify({error: "transport"})); }, timeout_ms);

    // copy the binary request body out of the heap
    let view = Module.HEAPU8.slice(body, body + body_length);

    // make request and process response or error
    let request;
    try {
      request = HttpClient.request({
        method: UTF8ToString(method),
        uri: UTF8ToString(uri),
        username: UTF8ToString(username),
        password: UTF8ToString(password),
        body: view,
        proxyUri: UTF8ToString(proxy_uri) || undefined,
        cancelToken: cancellation.token,
        resolveWithFullResponse: true,
        rejectUnauthorized: LibraryUtils.isRejectUnauthorized(UTF8ToString(reject_unauthorized_fn_id)),
      });
    } catch (err) {
      request = Promise.reject(err);
    }
    request.then(resp => {
      if (wakeUpCalled) return;
      // write the binary body to the heap; a body that is not bytes is passed as empty
      let respBin = resp.body instanceof Uint8Array ? resp.body : new Uint8Array(0);
      let bodyPtr = respBin.length > 0 ? Module._malloc(respBin.length) : 0;
      if (respBin.length > 0) Module.HEAPU8.set(respBin, bodyPtr);
      finish(JSON.stringify({code: resp.statusCode, message: "", headers: resp.headers || {}, bodyPtr: bodyPtr, bodyLength: respBin.length}));
    }).catch(err => {
      finish(JSON.stringify({error: "transport"})); // the error and its text are not read
    });
  });
});

EM_JS(void, js_cancel_http_request, (int client), {
  if (Module.httpRequestCancels && Module.httpRequestCancels[client]) {
    Module.httpRequestCancels[client]("Wallet is closing");
  }
});

// the JavaScript transport's scope for one permitted submit request (HttpClient.openRelayScope, closeRelayScope):
// opened and closed by the bridge's relay_prepared around its one call of the core's commit, from inside the module
EM_JS(void, js_relay_scope, (const char* scope, const char* uri, int count), {
  const HttpClient = this.HttpClient;
  if (count > 0) HttpClient.openRelayScope(UTF8ToString(scope), UTF8ToString(uri), count);
  else HttpClient.closeRelayScope(UTF8ToString(scope));
});

void epee::net_utils::http::http_client_wasm_relay_scope(const std::string& scope, const std::string& uri, int count) {
  js_relay_scope(scope.c_str(), uri.c_str(), count);
}

// Request bound: the core's timeout for the call, at least 1 s, and at most 30 s for
// a JSON request or 120 s for a binary request (blocks and hashes; up to 1,000 blocks per answer).
// The core asks for 3.5 minutes on its node RPC calls; the caps keep a silent node from holding a
// wallet's queue that long. The JavaScript transport cancels a request when it expires; the core
// then sees a failed request.
static const long long MIN_REQUEST_TIMEOUT_MS = 1000;
static const long long MAX_JSON_REQUEST_TIMEOUT_MS = 30000;
static const long long MAX_BINARY_REQUEST_TIMEOUT_MS = 120000;
static int effective_timeout_ms(std::chrono::milliseconds timeout, bool binary) {
  long long ms = (long long) timeout.count();
  long long cap = binary ? MAX_BINARY_REQUEST_TIMEOUT_MS : MAX_JSON_REQUEST_TIMEOUT_MS;
  if (ms < MIN_REQUEST_TIMEOUT_MS) ms = MIN_REQUEST_TIMEOUT_MS;
  if (ms > cap) ms = cap;
  return (int) ms;
}

// scheme, host and port from the core, then the bridge's validated base path, then the core's endpoint path
std::string http_client_wasm::request_uri(const boost::string_ref path) const {
  return string(m_ssl_enabled ? "https" : "http") + "://" + m_host + ":" + m_port + m_route->base_path + string(path.data(), path.size());
}

bool http_client_wasm::shutdown() {
  m_is_shutdown = true;
  js_cancel_http_request((int) this);
  return disconnect();
}

bool http_client_wasm::set_proxy(const std::string& address) {
  m_proxy_uri = address; // requests are proxied by the javascript http client
  return true;
}

void http_client_wasm::set_server(std::string host, std::string port, boost::optional<login> user, ssl_options_t ssl_options) {
  disconnect();
  m_host = host;
  m_port = port;
  m_user = user;
  m_ssl_enabled = ssl_options ? true : false;
}

void http_client_wasm::set_auto_connect(bool auto_connect) {
  m_auto_connect = auto_connect;
}

bool http_client_wasm::connect(std::chrono::milliseconds timeout) {
  if (m_is_shutdown) return false;
  if (m_host.empty()) return false; // no daemon configured: never reach the JavaScript transport
  m_is_connected = true;    // TODO: do something!
  return true;
}

bool http_client_wasm::disconnect() {
  m_is_connected = false;
  return true;
}

bool http_client_wasm::is_connected(bool *ssl) {
  return m_is_connected;
}

void build_http_header_info(const boost::property_tree::ptree& headers_node, http_header_info& header_info) {
  for (const auto& header : headers_node) {
    string key = header.first;
    string value = header.second.data();
    if (!epee::string_tools::compare_no_case(key, "Connection"))
      header_info.m_connection = value;
    else if(!epee::string_tools::compare_no_case(key, "Referrer"))
      header_info.m_referer = value;
    else if(!epee::string_tools::compare_no_case(key, "Content-Length"))
      header_info.m_content_length = value;
    else if(!epee::string_tools::compare_no_case(key, "Content-Type"))
      header_info.m_content_type = value;
    else if(!epee::string_tools::compare_no_case(key, "Transfer-Encoding"))
      header_info.m_transfer_encoding = value;
    else if(!epee::string_tools::compare_no_case(key, "Content-Encoding"))
      header_info.m_content_encoding = value;
    else if(!epee::string_tools::compare_no_case(key, "Host"))
      header_info.m_host = value;
    else if(!epee::string_tools::compare_no_case(key, "Cookie"))
      header_info.m_cookie = value;
    else if(!epee::string_tools::compare_no_case(key, "User-Agent"))
      header_info.m_user_agent = value;
    else if(!epee::string_tools::compare_no_case(key, "Origin"))
      header_info.m_origin = value;
    else
      header_info.m_etc_fields.emplace_back(key, value);
  }
}

// ---- the one way a submit request passes (see http_client_wasm_relay) ----

#if defined(ZEPHYR_TS_TEST_INSTRUMENTATION)
// test module only: records which check decided about a submit request ("relay-permit:<what>" in the test hooks'
// events: none, method, shape, parse, hash, passed), so that the tests can name the reason of a refusal
EM_JS(void, zephyr_ts_test_relay_permit, (const char* what), {
  var h = Module["__zephyrTsTestHooks"];
  if (!h) return;
  if (!h.events) h.events = [];
  h.events.push("relay-permit:" + UTF8ToString(what));
});
#define RELAY_PERMIT_EVENT(what) zephyr_ts_test_relay_permit(what)
#else
#define RELAY_PERMIT_EVENT(what) ((void) 0)
#endif

// the daemon's submit endpoints: the core's commit sends /sendrawtransaction; /send_raw_transaction is its alias
static bool is_submit_path(const string& path) {
  string p = path;
  std::transform(p.begin(), p.end(), p.begin(), [](unsigned char c) { return (char) std::tolower(c); });
  return p == "/sendrawtransaction" || p == "/send_raw_transaction";
}

// The scope id that lets this submit request pass, or "" (the JavaScript transport then refuses and counts it): only
// while the bridge's permit is armed with requests left, only POST /sendrawtransaction, only a body of exactly the
// core's shape ({"client":"","tx_as_hex":<hex>}; do_not_relay false and do_sanity_checks true only as the defaults
// they are) whose transaction parses and hashes to the permit's expected hash. A passed request uses the permit up. The transaction's bytes are
// parsed here and wiped; nothing of them is kept or reported.
static string relay_scope_for(http_client_wasm_route& route, const string& path, const string& method, const boost::string_ref body) {
  http_client_wasm_relay& relay = route.relay;
  if (relay.remaining <= 0 || relay.expected_hash.empty() || relay.scope.empty()) { RELAY_PERMIT_EVENT("none"); return string(); }
  if (path != "/sendrawtransaction" || method != "POST") { RELAY_PERMIT_EVENT("method"); return string(); }
  string text(body.data(), body.size());
  rapidjson::Document doc;
  doc.ParseInsitu(&text[0]); // string values stay in text, which is wiped below
  // the core's commit stores the request with epee's KV_SERIALIZE_OPT, which leaves out a field equal to its default:
  // do_not_relay (false) and do_sanity_checks (true) are not sent, and the daemon applies the same defaults. Either may
  // appear only with its default value; no other field may appear
  bool shape = !doc.HasParseError() && doc.IsObject() && doc.MemberCount() >= 2 && doc.MemberCount() <= 4
    && doc.HasMember("client") && doc["client"].IsString() && doc["client"].GetStringLength() == 0
    && doc.HasMember("tx_as_hex") && doc["tx_as_hex"].IsString()
    && (!doc.HasMember("do_not_relay") || (doc["do_not_relay"].IsBool() && !doc["do_not_relay"].GetBool()))
    && (!doc.HasMember("do_sanity_checks") || (doc["do_sanity_checks"].IsBool() && doc["do_sanity_checks"].GetBool()))
    && doc.MemberCount() == 2u + (doc.HasMember("do_not_relay") ? 1u : 0u) + (doc.HasMember("do_sanity_checks") ? 1u : 0u);
  cryptonote::blobdata blob;
  bool parsed = shape && epee::string_tools::parse_hexstr_to_binbuff(boost::string_ref(doc["tx_as_hex"].GetString(), doc["tx_as_hex"].GetStringLength()), blob);
  std::fill(text.begin(), text.end(), '\0');
  if (!shape) { RELAY_PERMIT_EVENT("shape"); return string(); }
  cryptonote::transaction tx;
  crypto::hash hash;
  bool ok = parsed && cryptonote::parse_and_validate_tx_from_blob(blob, tx, hash);
  std::fill(blob.begin(), blob.end(), '\0');
  if (!ok) { RELAY_PERMIT_EVENT("parse"); return string(); }
  if (epee::string_tools::pod_to_hex(hash) != relay.expected_hash) { RELAY_PERMIT_EVENT("hash"); return string(); }
  RELAY_PERMIT_EVENT("passed");
  relay.remaining--;
  return relay.scope;
}

// the class of the daemon's answer to the passed submit request: its HTTP status, then (status 200) its status compared
// with the core's constants and its boolean flags; the reason text and every other field are not read
static void record_relay_answer(http_client_wasm_route& route, int code, const string& body) {
  http_client_wasm_relay& relay = route.relay;
  relay.stage = RELAY_STAGE_ANSWERED;
  relay.http_status = code;
  relay.status = RELAY_STATUS_NONE;
  relay.flags = 0;
  if (code != 200) return;
  rapidjson::Document doc;
  doc.Parse(body.c_str());
  if (doc.HasParseError() || !doc.IsObject() || !doc.HasMember("status") || !doc["status"].IsString() || doc["status"].GetStringLength() == 0) { relay.status = RELAY_STATUS_UNREADABLE; return; }
  string status(doc["status"].GetString(), doc["status"].GetStringLength());
  relay.status = status == "OK" ? RELAY_STATUS_OK : status == "BUSY" ? RELAY_STATUS_BUSY : status == "Failed" ? RELAY_STATUS_FAILED : RELAY_STATUS_OTHER;
  const std::pair<const char*, unsigned> FLAGS[] = {{"low_mixin", RELAY_FLAG_LOW_MIXIN}, {"double_spend", RELAY_FLAG_DOUBLE_SPEND}, {"invalid_input", RELAY_FLAG_INVALID_INPUT},
    {"invalid_output", RELAY_FLAG_INVALID_OUTPUT}, {"too_big", RELAY_FLAG_TOO_BIG}, {"overspend", RELAY_FLAG_OVERSPEND}, {"fee_too_low", RELAY_FLAG_FEE_TOO_LOW},
    {"too_few_outputs", RELAY_FLAG_TOO_FEW_OUTPUTS}, {"tx_extra_too_big", RELAY_FLAG_TX_EXTRA_TOO_BIG}, {"sanity_check_failed", RELAY_FLAG_SANITY_CHECK_FAILED}, {"not_relayed", RELAY_FLAG_NOT_RELAYED}};
  for (const auto& f : FLAGS) if (doc.HasMember(f.first) && doc[f.first].IsBool() && doc[f.first].GetBool()) relay.flags |= f.second;
}

bool http_client_wasm::invoke_json(const boost::string_ref path, const boost::string_ref method, const boost::string_ref body, std::chrono::milliseconds timeout, const http_response_info** ppresponse_info, const fields_list& additional_params, bool submit, const std::string& relay_scope) {

  // make json request through javascript
  string uri = request_uri(path);
  string username = m_user ? m_user->username : string();
  string password = m_user ? string(m_user->password.data(), m_user->password.size()) : string();
  string method_str(method.data(), method.size());
  string body_str(body.data(), body.size());
  m_route->last_failure = 1;
  const char* resp_str = js_send_json_request((int) this, uri.c_str(), username.c_str(), password.c_str(), m_proxy_uri.c_str(), m_reject_unauthorized_fn_id.c_str(), method_str.c_str(), body_str.c_str(), effective_timeout_ms(timeout, false), relay_scope.c_str());
  std::fill(body_str.begin(), body_str.end(), '\0'); // a submit request's body is the transaction; nothing of it is kept
  if (resp_str == nullptr) { if (submit) m_route->relay.stage = RELAY_STAGE_NO_ANSWER; return false; }

  // deserialize response to property tree
  std::istringstream iss = std::istringstream(std::string(resp_str));
  free((char*) resp_str);
  boost::property_tree::ptree resp_node;
  boost::property_tree::read_json(iss, resp_node);

  // check for error
  boost::optional<boost::property_tree::ptree&> error = resp_node.get_child_optional("error");
  if (error) {
    if (submit) {
      string stage = resp_node.get<string>("stage", "sent");
      m_route->relay.stage = stage == "refused" ? RELAY_STAGE_REFUSED : stage == "connection" ? RELAY_STAGE_NOT_SENT : RELAY_STAGE_NO_ANSWER;
    }
    return false;
  }

  // build response object
  m_response_info.clear();
  m_response_info.m_mime_tipe = "application/json";
  m_response_info.m_response_comment = string();
  m_response_info.m_response_code = resp_node.get<int>("code");
  m_route->last_failure = m_response_info.m_response_code >= 200 && m_response_info.m_response_code < 300 ? 0 : 2;
  m_response_info.m_http_ver_hi = 0;
  m_response_info.m_http_ver_lo = 0;
  build_http_header_info(resp_node.get_child("headers"), m_response_info.m_header_info);
  m_response_info.m_body = resp_node.get<string>("body");
  if (submit) record_relay_answer(*m_route, m_response_info.m_response_code, m_response_info.m_body);

  // set response argument
  if (ppresponse_info && m_response_info.m_response_code != 401) {
    *ppresponse_info = std::addressof(m_response_info);
  }

  // return true iff 200
  return m_response_info.m_response_code == 200;
}

bool http_client_wasm::invoke_binary(const boost::string_ref path, const boost::string_ref method, const boost::string_ref body, std::chrono::milliseconds timeout, const http_response_info** ppresponse_info, const fields_list& additional_params) {

  // make binary request through javascript
  string uri = request_uri(path);
  string username = m_user ? m_user->username : string();
  string password = m_user ? string(m_user->password.data(), m_user->password.size()) : string();
  string method_str(method.data(), method.size());
  m_route->last_failure = 1;
  const char* resp_str = js_send_binary_request((int) this, uri.c_str(), username.c_str(), password.c_str(), m_proxy_uri.c_str(), m_reject_unauthorized_fn_id.c_str(), method_str.c_str(), body.data(), (int) body.size(), effective_timeout_ms(timeout, true));
  if (resp_str == nullptr) return false;

  // deserialize response to property tree
  std::istringstream iss = std::istringstream(std::string(resp_str));
  free((char*) resp_str);
  boost::property_tree::ptree resp_node;
  boost::property_tree::read_json(iss, resp_node);

  // check for error
  boost::optional<boost::property_tree::ptree&> error = resp_node.get_child_optional("error");
  if (error) return false;

  // build response object
  m_response_info.clear();
  m_response_info.m_mime_tipe = "application/octet_stream";
  m_response_info.m_response_comment = string();
  m_response_info.m_response_code = resp_node.get<int>("code");
  m_route->last_failure = m_response_info.m_response_code >= 200 && m_response_info.m_response_code < 300 ? 0 : 2;
  m_response_info.m_http_ver_hi = 0;
  m_response_info.m_http_ver_lo = 0;
  build_http_header_info(resp_node.get_child("headers"), m_response_info.m_header_info);

  // read binary body from response pointer, then free it
  int body_ptr = resp_node.get<int>("bodyPtr");
  int body_length = resp_node.get<int>("bodyLength");
  m_response_info.m_body = body_length > 0 ? string((char*) body_ptr, body_length) : string();
  if (body_ptr != 0) free((char*) body_ptr);

  // set response argument
  if (ppresponse_info && m_response_info.m_response_code != 401) {
    *ppresponse_info = std::addressof(m_response_info);
  }

  // return true iff 200
  return m_response_info.m_response_code == 200;
}

bool http_client_wasm::invoke(const boost::string_ref path, const boost::string_ref method, const boost::string_ref body, std::chrono::milliseconds timeout, const http_response_info** ppresponse_info, const fields_list& additional_params) {
  //cout << "invoke(" << path << ", " << method << ", ...)" << endl;
  if (m_is_shutdown) return false;

  // An unset daemon host (offline wallets) fails like an unreachable daemon before any request
  // is built, so the core's probes never reach HttpClient. The core itself is unchanged.
  if (m_host.empty()) return false;

  if(!is_connected())
  {
    if (!m_auto_connect && false)
    {
      return false;
    }
    MDEBUG("Reconnecting...");
    if(!connect(timeout))
    {
      return false;
    }
  }

  // invoke http call
  string path_str(path.data(), path.size());
  bool is_binary = path_str.size() >= 4 && 0 == path_str.compare(path_str.size() - 4, 4, string(".bin"));
  if (is_binary) return invoke_binary(path, method, body, timeout, ppresponse_info, additional_params);
  // a submit request passes only under the bridge's permit (relay_scope_for); without a scope id the JavaScript
  // transport refuses and counts it. Its record starts as "refused" and is updated by what the transport reports
  bool submit = is_submit_path(path_str);
  string relay_scope;
  if (submit) {
    m_route->relay.stage = RELAY_STAGE_REFUSED;
    m_route->relay.http_status = 0;
    m_route->relay.status = RELAY_STATUS_NONE;
    m_route->relay.flags = 0;
    relay_scope = relay_scope_for(*m_route, path_str, string(method.data(), method.size()), body);
  }
  return invoke_json(path, method, body, timeout, ppresponse_info, additional_params, submit, relay_scope);
}

bool http_client_wasm::invoke_get(const boost::string_ref path, std::chrono::milliseconds timeout, const std::string& body, const http_response_info** ppresponse_info, const fields_list& additional_params) {
  return http_client_wasm::invoke(path, "GET", body, timeout, ppresponse_info, additional_params);
}

bool http_client_wasm::invoke_post(const boost::string_ref path, const std::string& body, std::chrono::milliseconds timeout, const http_response_info** ppresponse_info, const fields_list& additional_params) {
  return http_client_wasm::invoke(path, "POST", body, timeout, ppresponse_info, additional_params);
}

uint64_t http_client_wasm::get_bytes_sent() const {
  cout << "get_bytes_sent()" << endl;
  throw runtime_error("http_client_wasm::get_bytes_sent() not implemented");
}

uint64_t http_client_wasm::get_bytes_received() const {
  cout << "get_bytes_received()" << endl;
  throw runtime_error("http_client_wasm::get_bytes_received() not implemented");
}
