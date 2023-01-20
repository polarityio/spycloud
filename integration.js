const _ = require('lodash');
const { map } = require('lodash/fp');
const Bottleneck = require('bottleneck/es5');
const config = require('./config/config');
const fs = require('fs');
const request = require('postman-request');

let limiter = null;
let requestWithDefaults;

let Logger;

const _setupLimiter = (options) => {
  limiter = new Bottleneck({
    maxConcurrent: Number.parseInt(options.maxConcurrent, 10), // no more than 5 lookups can be running at single time
    highWater: 100, // no more than 100 lookups can be queued up
    strategy: Bottleneck.strategy.OVERFLOW,
    minTime: Number.parseInt(options.minTime, 10) // don't run lookups faster than 1 every 200 ms
  });
};

function startup(logger) {
  let defaults = {};
  Logger = logger;
  const { cert, key, passphrase, ca, proxy, rejectUnauthorized } = config.request;

  if (typeof cert === 'string' && cert.length > 0) {
    defaults.cert = fs.readFileSync(cert);
  }
  if (typeof key === 'string' && key.length > 0) {
    defaults.key = fs.readFileSync(key);
  }
  if (typeof passphrase === 'string' && passphrase.length > 0) {
    defaults.passphrase = passphrase;
  }
  if (typeof ca === 'string' && ca.length > 0) {
    defaults.ca = fs.readFileSync(ca);
  }
  if (typeof proxy === 'string' && proxy.length > 0) {
    defaults.proxy = proxy;
  }
  if (typeof rejectUnauthorized === 'boolean') {
    defaults.rejectUnauthorized = rejectUnauthorized;
  }

  let _requestWithDefaults = request.defaults(defaults);

  requestWithDefaults = (requestOptions) =>
    new Promise((resolve, reject) => {
      _requestWithDefaults(requestOptions, (err, res, body) => {
        if (err) return reject(err);
        const response = { ...res, body };
        checkForStatusError(response).catch(reject);
        resolve(response);
      });
    });
}

const buildRequestOptions = (entity, options) => {
  const isSearchedEntity = true;
  let path;
  let API_URL = `https://api.spycloud.io`;

  switch (isSearchedEntity) {
    case entity.isEmail:
      path = `/enterprise-v2/breach/data/emails/${entity.value}`;
      break;
    case entity.isDomain:
      path = `/enterprise-v2/breach/data/domains/${entity.value}`;
      break;
    case entity.isIP:
      path = `/enterprise-v2/breach/data/ips/${entity.value}`;
      break;
    default:
      undefined;
  }

  return (requestOptions = {
    method: 'GET',
    url: API_URL + path,
    headers: {
      'X-Api-Key': options.apiKey
    },
    json: true
  });
};

const doLookup = async (entities, options, callback) => {
  if (!limiter) _setupLimiter(options);

  const fetchApiData = limiter.wrap(_fetchApiData);

  try {
    const lookupResults = await Promise.all(
      map(async (entity) => await fetchApiData(entity, options), entities)
    );

    return callback(null, lookupResults);
  } catch (err) {
    return callback(err);
  }
};

const _fetchApiData = async (entity, options) => {
  try {
    const requestOptions = buildRequestOptions(entity, options);

    Logger.trace({ requestOptions }, 'REQUEST_OPTIONS');

    response = await requestWithDefaults(requestOptions);

    Logger.trace({ response }, 'REQUEST_RESPONSE');

    const apiData =
      (fetchResponses[response.statusCode]||
      retryablePolarityResponse)(entity, response);

    Logger.trace({ apiData }, 'LOOKUP_RESULT');
    return apiData;
  } catch (err) {
    const isConnectionReset = _.get(err, 'code', '') === 'ECONNRESET';
    if (isConnectionReset) return retryablePolarityResponse(entity);
    else throw polarityError(err);
  }
};

const checkForStatusError = async (response) => {
  const statusCode = response.statusCode;

  if (![200, 429, 500, 502, 504].includes(statusCode)) {
    const requestError = Error('Request Error');
    requestError.status = statusCode;
    requestError.description = JSON.stringify(response.body);
    requestError.requestOptions = requestOptions;
    throw requestError;
  }
};
/**
 * These functions return potential response objects the integration can return to the client
 */
const polarityError = (err) => {
  const errorMsg = JSON.parse(err.description);
  return {
    detail: errorMsg ? errorMsg : 'Unexpected Error',
    error: err
  };
};

const polarityResponse = (entity, response) => {
  const data = response.body;
  return {
    entity,
    data: {
      summary: getSummary(data),
      details: data.results ? data.results : null
    }
  };
};

const emptyResponse = (entity) => ({
  entity,
  data: null
});

const retryablePolarityResponse = (entity) => ({
  entity,
  isVolatile: true,
  data: {
    summary: ['Lookup limit reached'],
    details: {
      summaryTag: 'Lookup limit reached',
      errorMessage:
        'A temporary SpyCloud API search limit was reached. You can retry your search by pressing the "Retry Search" button.'
    }
  }
});

const fetchResponses = {
  200: polarityResponse,
  400: emptyResponse,
  403: emptyResponse
};

const onMessage = (payload, options, callback) => {
  switch (payload.action) {
    case 'RETRY_LOOKUP':
      doLookup([payload.entity], options, (err, lookupResults) => {
        if (err) {
          Logger.error({ err }, 'Error retrying lookup');
          callback(err);
        } else {
          callback(
            null,
            lookupResults && lookupResults[0] && lookupResults[0].data === null
              ? { data: { summary: ['No Results Found on Retry'] } }
              : lookupResults[0]
          );
        }
      });
      break;
  }
};

function getSummary(data) {
  let tags = [];
  let cache = {};

  if (Object.keys(data.results).length > 0) {
    const hits = data.results.length;
    tags.push(`Hits: ${hits}`);
  }

  if (Object.keys(data.results).length > 0) {
    for (const tag of data.results) {
      if (!cache[tag.severity]) {
        tags.push(`Severity: ${tag.severity}`);
        cache[tag.severity] = true;
      }
    }
  }
  return tags;
}

function validateOption(errors, options, optionName, errMessage) {
  if (
    typeof options[optionName].value !== 'string' ||
    (typeof options[optionName].value === 'string' &&
      options[optionName].value.length === 0)
  ) {
    errors.push({
      key: optionName,
      message: errMessage
    });
  }
}

function validateOptions(options, callback) {
  let errors = [];

  validateOption(errors, options, 'apiUrl', 'You must provide an api url.');
  validateOption(errors, options, 'apiKey', 'You must provide a valid access key.');
  
  if (options.maxConcurrent.value < 1) {
    errors = errors.concat({
      key: 'maxConcurrent',
      message: 'Max Concurrent Requests must be 1 or higher'
    });
  }

  if (options.minTime.value < 1) {
    errors = errors.concat({
      key: 'minTime',
      message: 'Minimum Time Between Lookups must be 1 or higher'
    });
  }
  
  callback(null, errors);
}

module.exports = {
  doLookup,
  startup,
  onMessage,
  validateOptions
};
