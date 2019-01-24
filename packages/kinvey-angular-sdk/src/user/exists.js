"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exists;

var _regenerator = _interopRequireDefault(require("@babel/runtime/regenerator"));

var _asyncToGenerator2 = _interopRequireDefault(require("@babel/runtime/helpers/asyncToGenerator"));

var _isString = _interopRequireDefault(require("lodash/isString"));

var _config = require("../kinvey/config");

var _kinvey = _interopRequireDefault(require("../errors/kinvey"));

var _utils = require("../http/utils");

var _request = require("../http/request");

var _auth = require("../http/auth");

var RPC_NAMESPACE = 'rpc';

function exists(_x) {
  return _exists.apply(this, arguments);
}

function _exists() {
  _exists = (0, _asyncToGenerator2.default)(
  /*#__PURE__*/
  _regenerator.default.mark(function _callee(username) {
    var options,
        _getConfig,
        apiProtocol,
        apiHost,
        appKey,
        request,
        response,
        _args = arguments;

    return _regenerator.default.wrap(function _callee$(_context) {
      while (1) {
        switch (_context.prev = _context.next) {
          case 0:
            options = _args.length > 1 && _args[1] !== undefined ? _args[1] : {};
            _getConfig = (0, _config.get)(), apiProtocol = _getConfig.apiProtocol, apiHost = _getConfig.apiHost, appKey = _getConfig.appKey;

            if (username) {
              _context.next = 4;
              break;
            }

            throw new _kinvey.default('A username was not provided.');

          case 4:
            if ((0, _isString.default)(username)) {
              _context.next = 6;
              break;
            }

            throw new _kinvey.default('The provided username is not a string.');

          case 6:
            request = new _request.KinveyRequest({
              method: _request.RequestMethod.POST,
              auth: _auth.Auth.App,
              url: (0, _utils.formatKinveyUrl)(apiProtocol, apiHost, "/".concat(RPC_NAMESPACE, "/").concat(appKey, "/check-username-exists")),
              body: {
                username: username
              },
              timeout: options.timeout
            });
            _context.next = 9;
            return request.execute();

          case 9:
            response = _context.sent;
            return _context.abrupt("return", response.data.usernameExists === true);

          case 11:
          case "end":
            return _context.stop();
        }
      }
    }, _callee, this);
  }));
  return _exists.apply(this, arguments);
}