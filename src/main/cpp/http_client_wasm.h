#ifndef http_client_wasm_h
#define http_client_wasm_h

#pragma once

#include "net/abstract_http_client.h"
#include <memory>
#include <string>

using namespace std;
using namespace epee::net_utils::http;

namespace epee
{
  namespace net_utils
  {
    namespace http
    {
      /**
       * The one way a submit request can pass (the bridge's relay_prepared): a permit for exactly one
       * POST /sendrawtransaction whose transaction hashes to expected_hash, armed by the bridge around its one
       * call of the core's commit and cleared after it, and the record of what happened to that request. The
       * record holds only fixed classes: never a request or response body or node text.
       */
      struct http_client_wasm_relay {
        std::string expected_hash;  // 64 lowercase hex of the one transaction the permit passes; "" when not armed
        std::string scope;          // id of the JavaScript transport's scope opened for this permit
        int remaining = 0;          // submit requests the permit still passes (0 or 1)
        int stage = 0;              // RELAY_STAGE_* of the last submit request
        int http_status = 0;        // its HTTP status when answered
        int status = 0;             // RELAY_STATUS_* of the daemon's status when answered with 200
        unsigned flags = 0;         // RELAY_FLAG_* bits of the daemon's reply when answered with 200
      };
      const int RELAY_STAGE_NONE = 0;        // no submit request since the permit was armed
      const int RELAY_STAGE_REFUSED = 1;     // a submit request was refused before sending (here or in JavaScript)
      const int RELAY_STAGE_NOT_SENT = 2;    // the connection was refused: nothing was sent
      const int RELAY_STAGE_NO_ANSWER = 3;   // sent, and no answer came (timeout, dropped connection, network failure)
      const int RELAY_STAGE_ANSWERED = 4;    // an HTTP answer came
      const int RELAY_STATUS_NONE = 0, RELAY_STATUS_OK = 1, RELAY_STATUS_BUSY = 2, RELAY_STATUS_FAILED = 3, RELAY_STATUS_OTHER = 4, RELAY_STATUS_UNREADABLE = 5;
      // the daemon's reply flags (COMMAND_RPC_SEND_RAW_TX::response), in its own order
      const unsigned RELAY_FLAG_LOW_MIXIN = 1u << 0, RELAY_FLAG_DOUBLE_SPEND = 1u << 1, RELAY_FLAG_INVALID_INPUT = 1u << 2, RELAY_FLAG_INVALID_OUTPUT = 1u << 3,
        RELAY_FLAG_TOO_BIG = 1u << 4, RELAY_FLAG_OVERSPEND = 1u << 5, RELAY_FLAG_FEE_TOO_LOW = 1u << 6, RELAY_FLAG_TOO_FEW_OUTPUTS = 1u << 7,
        RELAY_FLAG_TX_EXTRA_TOO_BIG = 1u << 8, RELAY_FLAG_SANITY_CHECK_FAILED = 1u << 9, RELAY_FLAG_NOT_RELAYED = 1u << 10;

      /**
       * Daemon route shared by every client a wallet's factory creates. The bridge
       * keeps the same object per wallet handle: it sets the validated base path and the configured origin
       * (scheme, host and port as the SDK validated them; credentials are rejected before) before the core
       * receives the origin, reads the kind of the last transport failure to classify a failed daemon call,
       * and arms the relay permit. It holds no credentials, request or response text.
       */
      struct http_client_wasm_route {
        std::string base_path;  // "" or a validated path such as "/rpc", prefixed to every endpoint path
        std::string origin;     // the configured daemon origin, "" when none (the scope of a permitted submit request)
        int last_failure = 0;   // kind of the most recent request: 0 answered with 2xx, 1 no HTTP response, 2 HTTP status other than 2xx
        http_client_wasm_relay relay;
      };

      /** Open (count 1) or close (count 0) the JavaScript transport's scope for one permitted submit request to uri. */
      void http_client_wasm_relay_scope(const std::string& scope, const std::string& uri, int count);

      /**
       * Implements an abstract_http_client using a WebAssembly bridge.
       */
      class http_client_wasm : public abstract_http_client
      {
      public:
        http_client_wasm(const string& reject_unauthorized_fn_id, std::shared_ptr<http_client_wasm_route> route) : m_user(boost::none), m_reject_unauthorized_fn_id(reject_unauthorized_fn_id), m_route(route ? route : std::make_shared<http_client_wasm_route>()), m_ssl_enabled(false), m_is_connected(false), m_is_shutdown(false), m_response_info(), m_auto_connect(true) { }
        ~http_client_wasm() {
          disconnect();
        }

        bool set_proxy(const std::string& address) override;
        void set_server(std::string host, std::string port, boost::optional<login> user, ssl_options_t ssl_options = ssl_support_t::e_ssl_support_autodetect) override;
        void set_auto_connect(bool auto_connect) override;
        bool connect(std::chrono::milliseconds timeout) override;
        bool disconnect() override;
        bool shutdown(); // not virtual in the fixed core's epee abstract_http_client: never called by wallet2
        bool is_connected(bool *ssl = NULL) override;
        bool invoke(const boost::string_ref uri, const boost::string_ref method, const boost::string_ref body, std::chrono::milliseconds timeout, const http_response_info** ppresponse_info = NULL, const fields_list& additional_params = fields_list()) override;
        bool invoke_get(const boost::string_ref uri, std::chrono::milliseconds timeout, const string& body = string(), const http_response_info** ppresponse_info = NULL, const fields_list& additional_params = fields_list()) override;
        bool invoke_post(const boost::string_ref uri, const string& body, std::chrono::milliseconds timeout, const http_response_info** ppresponse_info = NULL, const fields_list& additional_params = fields_list()); // not virtual in the fixed core's epee abstract_http_client
        uint64_t get_bytes_sent() const override;
        uint64_t get_bytes_received() const override;

      private:
        std::string m_host;
        std::string m_port;
        std::string m_proxy_uri;
        boost::optional<login> m_user;
        string m_reject_unauthorized_fn_id;
        std::shared_ptr<http_client_wasm_route> m_route;
        bool m_ssl_enabled;
        bool m_is_connected;
        bool m_is_shutdown;
        http_response_info m_response_info;
        bool m_auto_connect;

        std::string request_uri(const boost::string_ref path) const;
        bool invoke_json(const boost::string_ref uri, const boost::string_ref method, const boost::string_ref body, std::chrono::milliseconds timeout, const http_response_info** ppresponse_info, const fields_list& additional_params, bool submit, const std::string& relay_scope);
        bool invoke_binary(const boost::string_ref uri, const boost::string_ref method, const boost::string_ref body, std::chrono::milliseconds timeout, const http_response_info** ppresponse_info, const fields_list& additional_params);
      };

      /**
       * Factory for WebAssembly http client.
       */
      class http_client_wasm_factory : public http_client_factory
      {
      public:
        http_client_wasm_factory(const string& reject_unauthorized_fn_id, std::shared_ptr<http_client_wasm_route> route = nullptr) : m_reject_unauthorized_fn_id(reject_unauthorized_fn_id), m_route(route ? route : std::make_shared<http_client_wasm_route>()) { }
        std::unique_ptr<abstract_http_client> create() override {
          return std::unique_ptr<epee::net_utils::http::abstract_http_client>(new http_client_wasm(m_reject_unauthorized_fn_id, m_route));
        }
      private:
        string m_reject_unauthorized_fn_id; // used to look up in JS if unauthorized certificates should be rejected
        std::shared_ptr<http_client_wasm_route> m_route; // shared with every client created here and with the bridge
      };
    }
  }
}

#endif /* http_client_wasm_h */
