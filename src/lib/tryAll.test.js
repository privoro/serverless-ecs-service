const {describe, it} = require("mocha");
const sinon = require('sinon');
const {tryAll} = require('./tryAll');
const assert = require('assert');

describe('tryAll', function(){
  it('returns a promise resolving to results of all callbacks in order', () => {
    let cb1 = sinon.stub().returns('foo');
    let cb2 = sinon.stub().returns('biz');
    let cb3 = sinon.stub().returns('bar');

    return tryAll(cb1, cb2, cb3).then(results => {
      return assert.deepStrictEqual(results,
        ['foo', 'biz', 'bar'],
        'expected return results');
    });
  });

  it('rethrows first callback error', () => {
    let cb1 = sinon.stub().returns('foo');
    let cb2 = sinon.stub().throws(new Error('forced error'));
    let cb3 = sinon.stub().returns('bar');

    return tryAll(cb1, cb2, cb3).then(()=>{
      assert.fail('tryAll should reject');
    }).catch(e => {
      assert.strictEqual(e.message, 'forced error');
      assert(cb3.notCalled, 'last cb should not be called');
    });

  });
});
