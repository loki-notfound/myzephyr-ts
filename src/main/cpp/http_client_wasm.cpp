#include <emscripten.h>
#include <emscripten/fetch.h>
#include <iostream>
#include "http_client_wasm.h"
#include <boost/property_tree/ptree.hpp>
#include <boost/property_tree/json_parser.hpp>
#include "string_tools.h"
#include "misc_log_ex.h"

using namespace std;

// The JavaScript transport. Each request is bounded by timeout_ms (the core's timeout
// for the call, capped by the bridge, see effective_timeout_ms) and cancelled when it expires. A
// failed request reports only {"error":"transport"}: no error text, URI, header or body of a
// failed request is copied into the module. A response reports its status code, headers and body
// for the core to parse; the status text supplied by the server is not copied.
EM_JS(const char*, js_send_json_request, (int client, const char* uri, const char* username, const char* password, const char* proxy_uri, const char* reject_unauthorized_fn_id, const char* method, const char* body, int timeout_ms), {
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
      finish(JSON.stringify({error: "transport"})); // the error and its text are not read
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

bool http_client_wasm::invoke_json(const boost::string_ref path, const boost::string_ref method, const boost::string_ref body, std::chrono::milliseconds timeout, const http_response_info** ppresponse_info, const fields_list& additional_params) {

  // make json request through javascript
  string uri = request_uri(path);
  string username = m_user ? m_user->username : string();
  string password = m_user ? string(m_user->password.data(), m_user->password.size()) : string();
  string method_str(method.data(), method.size());
  string body_str(body.data(), body.size());
  m_route->last_failure = 1;
  const char* resp_str = js_send_json_request((int) this, uri.c_str(), username.c_str(), password.c_str(), m_proxy_uri.c_str(), m_reject_unauthorized_fn_id.c_str(), method_str.c_str(), body_str.c_str(), effective_timeout_ms(timeout, false));
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
  m_response_info.m_mime_tipe = "application/json";
  m_response_info.m_response_comment = string();
  m_response_info.m_response_code = resp_node.get<int>("code");
  m_route->last_failure = m_response_info.m_response_code >= 200 && m_response_info.m_response_code < 300 ? 0 : 2;
  m_response_info.m_http_ver_hi = 0;
  m_response_info.m_http_ver_lo = 0;
  build_http_header_info(resp_node.get_child("headers"), m_response_info.m_header_info);
  m_response_info.m_body = resp_node.get<string>("body");

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
  else return invoke_json(path, method, body, timeout, ppresponse_info, additional_params);
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
