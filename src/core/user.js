/**
 * Copyright 2014 Kinvey, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Users.
// ------

// REST API wrapper for user management with the Kinvey services. Note the
// [active user](http://devcenter.kinvey.com/guides/users#ActiveUser) is not
// exclusively managed in this namespace: `Kinvey.getActiveUser` and
// `Kinvey.Auth.Session` operate on the active user as well.

/**
 * @memberof! <global>
 * @namespace Kinvey.User
 */
Kinvey.User = /** @lends Kinvey.User */{
  /**
   * Signs up a new user.
   *
   * @param {Object} [data] User data.
   * @param {Options} [options] Options.
   * @returns {Promise} The new user.
   */
  signup: function(data, options) {
    // Debug.
    logger.debug('Signing up a new user.', arguments);

    // Forward to `Kinvey.User.create`. Signup, however, always marks the
    // created user as the active user.
    options = options || {};
    options.state = true;// Overwrite.
    return Kinvey.User.create(data, options);
  },

  /**
   * Signs up a new user through a provider.
   *
   * @param {string} provider  Provider.
   * @param {Object} tokens    Tokens.
   * @param {Object} [options] Options.
   * @returns {Promise} The active user.
   */
  signupWithProvider: function(provider, tokens, options) {
    // Debug.
    logger.debug('Signing up a new user with a provider.', arguments);

    // Parse tokens.
    var data = { _socialIdentity: { } };
    data._socialIdentity[provider] = tokens;

    // Forward to `Kinvey.User.signup`.
    return Kinvey.User.signup(data, options);
  },

  /**
   * Logs in an existing user.
   * NOTE If `options._provider`, this method should trigger a BL script.
   *
   * @param {Object|string} usernameOrData Username, or user data.
   * @param {string} [password] Password.
   * @param {Options} [options] Options.
   * @param {boolean} [options._provider] Login via Business Logic. May only
   *          be used internally to provide social login for browsers.
   * @returns {Promise} The active user.
   */
  login: function(usernameOrData, password, options) {
    var error;

    // Debug.
    logger.debug('Logging in an existing user.', arguments);

    // Cast arguments.
    if(isObject(usernameOrData)) {
      options = 'undefined' !== typeof options ? options : password;
    }
    else {
      usernameOrData = { username: String(usernameOrData), password: String(password) };
    }
    options = options || {};

    // Validate arguments.
    if((null == usernameOrData.username || '' === usernameOrData.username.trim() || null == usernameOrData.password || '' === usernameOrData.password.trim()) && null == usernameOrData._socialIdentity) {
      error = new Kinvey.Error('Username and/or password missing. Please provide both a username and password to login.');
      return wrapCallbacks(Kinvey.Defer.reject(error), options);
    }

    // Validate preconditions.
    if(null !== Kinvey.getActiveUser()) {
      error = clientError(Kinvey.Error.ALREADY_LOGGED_IN);
      return wrapCallbacks(Kinvey.Defer.reject(error), options);
    }

    // Login with the specified credentials.
    var promise = Kinvey.Persistence.create({
      namespace  : USERS,
      collection : options._provider ? null : 'login',
      data       : usernameOrData,
      flags      : options._provider ? { provider: options._provider } : {},
      auth       : Auth.App,
      local      : { res: true }
    }, options).then(function(user) {
      // Set and return the active user.
      Kinvey.setActiveUser(user);
      return user;
    });

    // Debug.
    promise.then(function(response) {
      logger.debug('Logged in the user.', response);
    }, function(error) {
      logger.error('Failed to login the user.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Logs in an existing user through a provider.
   *
   * @param {string} provider  Provider.
   * @param {Object} tokens    Tokens.
   * @param {Object} [options] Options.
   * @returns {Promise} The active user.
   */
  loginWithProvider: function(provider, tokens, options) {
    // Debug.
    logger.debug('Logging in with a provider.', arguments);

    // Parse tokens.
    var data = { _socialIdentity: { } };
    data._socialIdentity[provider] = tokens;

    // Forward to `Kinvey.User.login`.
    return Kinvey.User.login(data, options);
  },

  /**
   * Logs out the active user.
   *
   * @param {Options} [options] Options.
   * @returns {Promise} The previous active user.
   */
  logout: function(options) {
    // Cast arguments.
    options = options || {};

    // If `options.silent`, resolve immediately if there is no active user.
    var promise;
    if (null === Kinvey.getActiveUser()) {
      promise = Kinvey.Defer.resolve(null);
    }
    else {// Otherwise, attempt to logout the active user.
      // Debug.
      logger.debug('Logging out the active user.', arguments);

      // Prepare the response.
      promise = Kinvey.Persistence.create({
        namespace  : USERS,
        collection : '_logout',
        auth       : Auth.Session
      }, options).then(null, function() {
        return null;
      }).then(function() {
        // Disconnect MIC
        return MIC.disconnect();
      }).then(function() {
        var error;

        // Reset the active user, and return the previous active user. Make
        // sure to delete the authtoken.
        var previous = Kinvey.setActiveUser(null);

        // Check if previous has property _kmd. Thrown error will cause promise to be
        // rejected
        if (previous._kmd == null) {
          error = new Kinvey.Error('The previous active user does not have _kmd defined' +
                                   'as a property.');
          throw error;
        }

        if(null !== previous) {
          delete previous._kmd.authtoken;
        }
        return previous;
      });

      // Debug.
      promise.then(function(response) {
        logger.debug('Logged out the active user.', response);
      }, function(error) {
        logger.error('Failed to logout the active user.', error);
      });
    }

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Retrieves information on the active user.
   *
   * @param {Options} [options] Options.
   * @returns {Promise} The active user.
   */
  me: function(options) {
    // Debug.
    logger.debug('Retrieving information on the active user.', arguments);

    // Cast arguments.
    options = options || {};

    // Prepare the response.
    var promise = Kinvey.Persistence.read({
      namespace  : USERS,
      collection : '_me',
      auth       : Auth.Session,
      local      : { req: true, res: true }
    }, options).then(function(user) {
      // The response is a fresh copy of the active user. However, the response
      // does not contain `_kmd.authtoken`. Therefore, extract it from the
      // stale copy.
      user._kmd = user._kmd || {};
      if(null == user._kmd.authtoken) {
        user._kmd.authtoken = Kinvey.getActiveUser()._kmd.authtoken;
      }

      // Set and return the active user.
      Kinvey.setActiveUser(user);
      return user;
    });

    // Debug.
    promise.then(function(response) {
      logger.debug('Retrieved information on the active user.', response);
    }, function(error) {
      logger.error('Failed to retrieve information on the active user.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Requests e-mail verification for a user.
   *
   * @param {string} username Username.
   * @param {Options} [options] Options.
   * @returns {Promise} The response.
   */
  verifyEmail: function(username, options) {
    // Debug.
    logger.debug('Requesting e-mail verification.', arguments);

    // Cast arguments.
    options = options || {};

    // Prepare the response.
    var promise = Kinvey.Persistence.create({
      namespace  : RPC,
      collection : username,
      id         : 'user-email-verification-initiate',
      auth       : Auth.App
    }, options);

    // Debug.
    promise.then(function(response) {
      logger.debug('Requested e-mail verification.', response);
    }, function(error) {
      logger.error('Failed to request e-mail verification.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Requests a username reminder for a user.
   *
   * @param {string} email E-mail.
   * @param {Options} [options] Options.
   * @returns {Promise} The response.
   */
  forgotUsername: function(email, options) {
    // Debug.
    logger.debug('Requesting a username reminder.', arguments);

    // Cast arguments.
    options = options || {};

    // Prepare the response.
    var promise = Kinvey.Persistence.create({
      namespace : RPC,
      id        : 'user-forgot-username',
      data      : { email: email },
      auth      : Auth.App
    }, options);

    // Debug.
    promise.then(function(response) {
      logger.debug('Requested a username reminder.', response);
    }, function(error) {
      logger.error('Failed to request a username reminder.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Requests a password reset for a user.
   *
   * @param {string} username Username.
   * @param {Options} [options] Options.
   * @returns {Promise} The response.
   */
  resetPassword: function(username, options) {
    // Debug.
    logger.debug('Requesting a password reset.', arguments);

    // Cast arguments.
    options = options || {};

    // Prepare the response.
    var promise = Kinvey.Persistence.create({
      namespace  : RPC,
      collection : username,
      id         : 'user-password-reset-initiate',
      auth       : Auth.App
    }, options);

    // Debug.
    promise.then(function(response) {
      logger.debug('Requested a password reset.', response);
    }, function(error) {
      logger.error('Failed to request a password reset.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Checks whether a username exists.
   *
   * @param {string} username Username to check.
   * @param {Options} [options] Options.
   * @returns {Promise} `true` if username exists, `false` otherwise.
   */
  exists: function(username, options) {
    // Debug.
    logger.debug('Checking whether a username exists.', arguments);

    // Cast arguments.
    options = options || {};

    // Prepare the response.
    var promise = Kinvey.Persistence.create({
      namespace : RPC,
      id        : 'check-username-exists',
      data      : { username: username },
      auth      : Auth.App
    }, options).then(function(response) {
      return response.usernameExists;
    });

    // Debug.
    promise.then(function(response) {
      logger.debug('Checked whether the username exists.', response);
    }, function(error) {
      logger.error('Failed to check whether the username exists.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Creates a new user.
   *
   * @param {Object} [data] User data.
   * @param {Options} [options] Options.
   * @param {boolean} [options.state=true] Save the created user as the active
   *          user.
   * @returns {Promise} The new user.
   */
  create: function(data, options) {
    // Debug.
    logger.debug('Creating a new user.', arguments);

    // Cast arguments.
    options = options || {};

    // If `options.state`, validate preconditions.
    if(false !== options.state && null !== Kinvey.getActiveUser()) {
      var error = clientError(Kinvey.Error.ALREADY_LOGGED_IN);
      return wrapCallbacks(Kinvey.Defer.reject(error), options);
    }

    // Create the new user.
    var promise = Kinvey.Persistence.create({
      namespace : USERS,
      data      : data || {},
      auth      : Auth.App
    }, options).then(function(user) {
      // If `options.state`, set the active user.
      if(false !== options.state) {
        Kinvey.setActiveUser(user);
      }
      return user;
    });

    // Debug.
    promise.then(function(response) {
      logger.debug('Created the new user.', response);
    }, function(error) {
      logger.error('Failed to create the new user.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Updates a user. To create a user, use `Kinvey.User.create` or
   * `Kinvey.User.signup`.
   *
   * @param {Object} data User data.
   * @param {Options} [options] Options.
   * @param {string} [options._provider] Do not strip the `access_token` for
   *          this provider. Should only be used internally.
   * @returns {Promise} The user.
   */
  update: function(data, options) {
    var error;

    // Debug.
    logger.debug('Updating a user.', arguments);

    // Validate arguments.
    if(null == data._id) {
      error = new Kinvey.Error('data argument must contain: _id');
      return wrapCallbacks(Kinvey.Defer.reject(error), options);
    }

    // Cast arguments.
    options = options || {};

    // Delete the social identities’ access tokens, unless the identity is
    // `options._provider`. The tokens will be re-added after updating.
    var tokens = [];
    if(null != data._socialIdentity) {
      for(var identity in data._socialIdentity) {
        if(data._socialIdentity.hasOwnProperty(identity)) {
          if(null != data._socialIdentity[identity] && identity !== options._provider) {
            tokens.push({
              provider            : identity,
              access_token        : data._socialIdentity[identity].access_token,
              access_token_secret : data._socialIdentity[identity].access_token_secret
            });
            delete data._socialIdentity[identity].access_token;
            delete data._socialIdentity[identity].access_token_secret;
          }
        }
      }
    }

    // Prepare the response.
    var promise = Kinvey.Persistence.update({
      namespace : USERS,
      id        : data._id,
      data      : data,
      auth      : Auth.Default,
      local     : { res: true }
    }, options).then(function(user) {
      // Re-add the social identities’ access tokens.
      tokens.forEach(function(identity) {
        var provider = identity.provider;
        if(null != user._socialIdentity && null != user._socialIdentity[provider]) {
          ['access_token', 'access_token_secret'].forEach(function(field) {
            if(null != identity[field]) {
              user._socialIdentity[provider][field] = identity[field];
            }
          });
        }
      });

      // If we just updated the active user, refresh it.
      var activeUser = Kinvey.getActiveUser();

      if (null !== activeUser) {
        // Check activeUser for property _id. Thrown error will reject promise.
        if (activeUser._id == null) {
          error = new Kinvey.Error('Active user does not have _id property defined.');
          throw error;
        }

        // Check user for property _id. Thrown error will reject promise.
        if (user._id == null) {
          error = new Kinvey.Error('User does not have _id property defined.');
          throw error;
        }

        if (activeUser._id === user._id) {
          // Debug.
          logger.debug('Updating the active user because the updated user was the active user.');
          Kinvey.setActiveUser(user);
        }
      }

      return user;
    });

    // Debug.
    promise.then(function(response) {
      logger.debug('Updated the user.', response);
    }, function(error) {
      logger.error('Failed to update the user.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Retrieves all users matching the provided query.
   *
   * @param {Kinvey.Query} [query] The query.
   * @param {Options} [options] Options.
   * @param {boolean} [discover=false] Use
   *          [User Discovery](http://devcenter.kinvey.com/guides/users#lookup).
   * @returns {Promise} A list of users.
   */
  find: function(query, options) {
    var error;

    // Debug.
    logger.debug('Retrieving users by query.', arguments);

    // Validate arguments.
    if(null != query && !(query instanceof Kinvey.Query)) {
      error = new Kinvey.Error('query argument must be of type: Kinvey.Query.');
      return wrapCallbacks(Kinvey.Defer.reject(error), options);
    }

    // Cast arguments.
    options = options || {};

    // If `options.discover`, use
    // [User Discovery](http://devcenter.kinvey.com/guides/users#lookup)
    // instead of querying the user namespace directly.
    var promise;
    if(options.discover) {
      // Debug.
      logger.debug('Using User Discovery because of the discover flag.');

      // Prepare the response.
      promise = Kinvey.Persistence.create({
        namespace  : USERS,
        collection : '_lookup',
        data       : null != query ? query.toJSON().filter : null,
        auth       : Auth.Default,
        local      : { req: true, res: true }
      }, options);
    }
    else {
      // Prepare the response.
      promise = Kinvey.Persistence.read({
        namespace  : USERS,
        query      : query,
        auth       : Auth.Default,
        local      : { req: true, res: true }
      }, options);
    }

    // Debug.
    promise.then(function(response) {
      logger.debug('Retrieved the users by query.', response);
    }, function(error) {
      logger.error('Failed to retrieve the users by query.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Retrieves a user.
   *
   * @param {string} id User id.
   * @param {Options} [options] Options.
   * @returns {Promise} The user.
   */
  get: function(id, options) {
    // Debug.
    logger.debug('Retrieving a user.', arguments);

    // Cast arguments.
    options = options || {};

    // Prepare the response.
    var promise = Kinvey.Persistence.read({
      namespace : USERS,
      id        : id,
      auth      : Auth.Default,
      local     : { req: true, res: true }
    }, options);

    // Debug.
    promise.then(function(response) {
      logger.debug('Retrieved the user.', response);
    }, function(error) {
      logger.error('Failed to return the user.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Deletes a user.
   *
   * @param {string} id User id.
   * @param {Options} [options] Options.
   * @param {boolean} [options.hard=false] Perform a hard delete.
   * @param {boolean} [options.silent=false] Succeed if the user did not exist
   *          prior to deleting.
   * @returns {Promise} The response.
   */
  destroy: function(id, options) {
    var error;

    // Debug.
    logger.debug('Deleting a user.', arguments);

    // Cast arguments.
    options = options || {};

    // Prepare the response.
    var promise = Kinvey.Persistence.destroy({
      namespace : USERS,
      id        : id,
      flags     : options.hard ? { hard: true } : {},
      auth      : Auth.Default,
      local     : { res: true }
    }, options).then(function(response) {
      // If we just deleted the active user, unset it here.
      var activeUser = Kinvey.getActiveUser();

      if (null !== activeUser) {
        // Check activeUser for property _id. Thrown error will reject promise.
        if (activeUser._id == null) {
          error = new Kinvey.Error('Active user does not have _id property defined.');
          throw error;
        }

        if (activeUser._id === id) {
          // Debug.
          logger.debug('Deleting the active user because the deleted user was the active user.');
          Kinvey.setActiveUser(null);
        }
      }

      return response;
    }, function(error) {
      // If `options.silent`, treat `USER_NOT_FOUND` as success.
      if(options.silent && Kinvey.Error.USER_NOT_FOUND === error.name) {
        // Debug.
        logger.debug('The user does not exist. Returning success because of the silent flag.');
        return null;
      }
      return Kinvey.Defer.reject(error);
    });

    // Debug.
    promise.then(function(response) {
      logger.debug('Deleted the user.', response);
    }, function(error) {
      logger.error('Failed to delete the user.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Restores a previously disabled user.
   *
   * @param {string} id User id.
   * @param {Options} [options] Options.
   * @returns {Promise} The response.
   */
  restore: function(id, options) {
    // Debug.
    logger.debug('Restoring a previously disabled user.', arguments);

    // Cast arguments.
    options = options || {};

    // Prepare the response.
    var promise = Kinvey.Persistence.create({
      namespace  : USERS,
      collection : id,
      id         : '_restore',
      auth       : Auth.Master
    }, options);

    // Debug.
    promise.then(function(response) {
      logger.debug('Restored the previously disabled user.', response);
    }, function(error) {
      logger.error('Failed to restore the previously disabled user.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Performs a count operation.
   *
   * @param {Kinvey.Query} [query] The query.
   * @param {Options} [options] Options.
   * @returns {Promise} The response.
   */
  count: function(query, options) {
    var error;

    // Debug.
    logger.debug('Counting the number of users.', arguments);

    // Validate arguments.
    if(null != query && !(query instanceof Kinvey.Query)) {
      error = new Kinvey.Error('query argument must be of type: Kinvey.Query.');
      return wrapCallbacks(Kinvey.Defer.reject(error), options);
    }

    // Cast arguments.
    options = options || {};

    // Prepare the response.
    var promise = Kinvey.Persistence.read({
      namespace : USERS,
      id        : '_count',
      query     : query,
      auth      : Auth.Default,
      local     : { req: true }
    }, options).then(function(response) {
      return response.count;
    });

    // Debug.
    promise.then(function(response) {
      logger.debug('Counted the number of users.', response);
    }, function(error) {
      logger.error('Failed to count the number of users.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  },

  /**
   * Performs a group operation.
   *
   * @param {Kinvey.Aggregation} aggregation The aggregation.
   * @param {Options} [options] Options.
   * @returns {Promise} The response.
   */
  group: function(aggregation, options) {
    var error;

    // Debug.
    logger.debug('Grouping users.', arguments);

    // Validate arguments.
    if(!(aggregation instanceof Kinvey.Group)) {
      error = new Kinvey.Error('aggregation argument must be of type: Kinvey.Group.');
      return wrapCallbacks(Kinvey.Defer.reject(error), options);
    }

    // Cast arguments.
    options = options || {};

    // Prepare the response.
    var promise = Kinvey.Persistence.create({
      namespace : USERS,
      id        : '_group',
      data      : aggregation.toJSON(),
      auth      : Auth.Default,
      local     : { req: true }
    }, options).then(function(response) {
      // Process the raw response.
      return aggregation.postProcess(response);
    });

    // Debug.
    promise.then(function(response) {
      logger.debug('Grouped the users.', response);
    }, function(error) {
      logger.error('Failed to group the users.', error);
    });

    // Return the response.
    return wrapCallbacks(promise, options);
  }
};