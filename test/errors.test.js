const nock = require('nock');
const { doLookup, startup } = require('../integration');

const options = {
  apiKey: '',
  maxConcurrent: 20,
  minTime: 1
};

const domain = {
  type: 'domain',
  value: 'polarity.io',
  isDomain: true
};

const Logger = {
  trace: (args, msg) => {
    console.info(msg, args);
  },
  info: (args, msg) => {
    console.info(msg, args);
  },
  error: (args, msg) => {
    console.info(msg, args);
  },
  debug: (args, msg) => {
    console.info(msg, args);
  },
  warn: (args, msg) => {
    console.info(msg, args);
  }
};

beforeAll(() => {
  startup(Logger);
});

[502, 504].forEach((statusCode) => {
  test(`${statusCode} response when calling 'https://api.spycloud.io/enterprise-v2'  should return a retryable response`, (done) => {
    const scope = nock(`https://api.spycloud.io`).get(/.*/).query(true).reply(statusCode);

    doLookup([domain], options, (err, lookupResults) => {
      console.info(lookupResults);
      const details = lookupResults[0].data.details;
      expect(details.errorMessage).toBe(
        'A temporary SpyCloud API search limit was reached. You can retry your search by pressing the "Retry Search" button.'
      );
      expect(details.summaryTag).toBe('Lookup limit reached');
      done();
    });
  });
});

test('ECONNRESET response when calling `https://api.spycloud.io/enterprise-v2` should result in a retryable response', (done) => {
  const scope = nock(`https://api.spycloud.io`)
    .get(/.*/)
    .query(true)
    .replyWithError({ code: 'ECONNRESET' });

  doLookup([domain], options, (err, lookupResults) => {
    console.info(err);
    console.info(lookupResults[0].data.details);
    const details = lookupResults[0].data.details;
    expect(details.errorMessage).toBe(
      'A temporary SpyCloud API search limit was reached. You can retry your search by pressing the "Retry Search" button.'
    );
    expect(details.summaryTag).toBe('Lookup limit reached');
    done();
  });
});
