const Promise = require('bluebird');
module.exports = {
  /**
   *
   * @param {...callback} callbacks
   * @returns {Promise<any>}
   */
  tryAll: function(...callbacks) {
    return Promise.mapSeries(callbacks, callback => Promise.try(callback));
  }
};
