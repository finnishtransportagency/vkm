const Promise = require("bluebird");
const rp = require("request-promise");
const xlsx = require("node-xlsx");
const R = require("ramda");

const API_URL = "http://10.129.65.32:8997/vkm/muunnos";
const GEOCODE_URL = "http://10.129.65.32:8997/vkm/geocode";
const REVERSE_GEOCODE_URL = "http://10.129.65.32:8997/vkm/reversegeocode";
const HEADERS = ["X", "Y", "Tie", "Tieosa", "Etäisyys", "Ajorata", "Katuosoite", "Kunta"];
const ERROR_HEADER = "Virheviesti";
const COORDINATE_KEYS = ["x", "y"];
const ADDRESS_KEYS = ["tie", "osa", "etaisyys", "ajorata"];
const GEOCODE_KEYS = ["osoite", "kunta"];
const EXTERNAL_ERROR_KEYS = ["palautusarvo", "virheteksti"];
const ERROR_KEYS = ["valid", "error"].concat(EXTERNAL_ERROR_KEYS);
const KEYS = COORDINATE_KEYS.concat(ADDRESS_KEYS).concat(GEOCODE_KEYS);
const LOCALIZED = {
  address: {
    plural: "tieosoitteet",
    singular: "tieosoite"
  },
  coordinate: {
    plural: "koordinaatit",
    singular: "koordinaatti"
  }
};
const MISSING_VALUE_ERROR = "Kohdetta ei löytynyt";
const CONCURRENCY_LIMIT = 5;

exports.convert = function(buffer) {
  const worksheet = xlsx.parse(buffer)[0];

  return fillMissingValuesFromBackend(worksheet.data)
    .then(buildOutput(worksheet.name));
}

function fillMissingValuesFromBackend(table) {
  const values = parseTable(table);
  const valid = !R.any(R.isNil, R.flatten(R.map(R.values, values)));

  const nonEmpty = R.reject(R.isEmpty);
  const headerKeys = headersToKeys(nonEmpty(table[0]));

  const coordinates = R.contains(headerKeys, COORDINATE_KEYS);
  const addresses = R.equals(headerKeys, ADDRESS_KEYS);
  const geocode = R.equals(headerKeys, GEOCODE_KEYS);

  if (valid) {
    if (coordinates) return decorateWithAddresses(values).then(decorateWithReverseGeocode);
    if (addresses) return decorateWithCoordinates(values).then(decorateWithReverseGeocode);
    if (geocode) return decorateWithGeocode(values).then(decorateWithAddresses);
  }
  return new Promise((_, reject) => reject("Parsing failed"));
}

function buildOutput(fileName) {
  return function(data) {
    const metadata = getMetadata(data);
    const valuesOrderedByKeys = data.map(x => {
      const valueOrderedByKeys = KEYS.map(key => R.prop(key, x));
      return x.valid ? valueOrderedByKeys : valueOrderedByKeys.concat(x.error);
    });
    const headerRow = metadata.errors ? HEADERS.concat(ERROR_HEADER) : HEADERS;
    const table = [headerRow].concat(valuesOrderedByKeys);
    return {
      xlsx: xlsx.build([{name: fileName, data: table }]),
      metadata: metadata
    };
  }
}

function getMetadata(data) {
  const notValid = R.compose(R.not, R.prop("valid"));
  if (R.any(notValid, data)) {
    const rowOffset = 2;
    return {
      errors: true,
      errorCount: R.filter(notValid, data).length,
      firstError: R.findIndex(notValid, data) + rowOffset
    }
  } else {
    return {
      errors: false
    };
  }
}

// parseTable :: [[String]] -> [Object]
//
// > parseTable([["X", "Y"], ["12.34", "45.67"]])
// [{ x: "12.34", y: "45.67" }]
//
// > parseTable([["X", "Y"], ["12.34", "45.67"], ["", ""]])
// [{ x: "12.34", y: "45.67" }]
//
// > parseTable([["12.34", "45.67"]])
// Error
//
// > parseTable([["X", "invalidKey"], ["12.34", "45.67"]])
// Error
//

function parseTable(values) {
  const hasHeader = (x) => R.all(R.contains(R.__, HEADERS))(x[0]);
  const onlyNonEmptyRows = R.reject(R.all(R.isEmpty));

  if (hasHeader(values)) {
    return tableToObjects(onlyNonEmptyRows(values));
  } else {
    throw new Error("You must specity a header");
  }
}


// tableToObjects :: [[String]] -> [Object]
//
// > tableToObjects([["X", "Y"], ["12.34", "45.67"]])
// [{ x: "12.34", y: "45.67" }]
//
// > tableToObjects([["Tie", "Tieosa", "Etäisyys", "Ajorata"], [4, 117, 4975, 0]])
// [{ tie: 4, osa: 117, etaisyys: 4975, ajorata: 0 }]

function tableToObjects(table) {
  const headers = R.head(table);
  const content = R.tail(table);

  return R.map(R.zipObj(headersToKeys(headers)), content);
}

// headersToKeys :: [String] -> [String]
//
// > headersToKeys(["Etäisyys", "Katuosoite", "Kunta"])
// ["etaisyys", "osoite", "kunta"]

const headersToKeys = R.map((x) => KEYS[HEADERS.indexOf(x)]);

const decorateWithAddresses = (coordinates) => decorateWith(LOCALIZED.coordinate, LOCALIZED.address, coordinates, ADDRESS_KEYS);
const decorateWithCoordinates = (addresses) => decorateWith(LOCALIZED.address, LOCALIZED.coordinate, addresses, COORDINATE_KEYS);

function decorateWith(inputType, outputType, values, whitelistedKeys) {
  const payload = {};
  payload[inputType.plural] = values;
  const data = {
    in: inputType.singular,
    out: outputType.singular,
    callback: null,
    kohdepvm: null,
    json: JSON.stringify(payload)
  };
  const parse = R.compose(
      R.map(validate),
      decorate(values),
      R.map(R.pick(whitelistedKeys.concat(ERROR_KEYS))),
      R.propOr([], outputType.plural),
      parseJSON
  );
  return httpPost(API_URL, data).then(parse);
}

function decorateWithReverseGeocode(values) {
  const reverseGeocode = value => httpGet(REVERSE_GEOCODE_URL, R.pick(COORDINATE_KEYS, value));
  return Promise.map(values, reverseGeocode, { concurrency: CONCURRENCY_LIMIT })
    .map(R.compose(R.pick(GEOCODE_KEYS), parseJSON))
    .then(decorate(values));
}

function decorateWithGeocode(values) {
  const createQueryParams = R.compose(R.join(", "), R.values, R.pick(GEOCODE_KEYS));
  const geocode = value => httpGet(GEOCODE_URL, { address: createQueryParams(value) });
  const parse = R.compose(headOr({valid: false, error: MISSING_VALUE_ERROR}), R.prop("results"), parseJSON);
  return Promise.map(values, geocode, { concurrency: CONCURRENCY_LIMIT })
    .map(parse)
    .then(decorate(values));
}

function httpPost(url, params) {
  return rp.post({ url: url, form: params, encoding: "utf-8" })
    .then(x => x.replace(/ï¿½/g, "ö"));
}

function httpGet(url, params) {
  return rp({ url: url, qs: params });
}

function parseJSON(str) {
  return str.trim() ? JSON.parse(str) : {};
}

// decorate :: [Object] -> [String] -> [Object]
//
// > decorate([{x: 1, y: 2}])([{tie: 3}])
// [{x: 1, y: 2, tie: 3}]
//
// > decorate([{x: 1}])([{x: 2}])
// [{x: 1}]

function decorate(xs) {
  const defaults = R.flip(R.merge);
  return R.zipWith(defaults, xs);
}

// headOr :: a -> [a] -> a
//
// > headOr(1)([2])
// 2
//
// > headOr(1)([])
// 1
function headOr(defaultVal) {
  return function(xs) {
    return xs.length > 0 ? xs[0] : defaultVal;
  }
}


// validate :: Object -> Object
//
// > validate({palautusarvo: 0, virheteksti: "Kohdetta ei löytynyt"})
// {valid: false, error: "Kohdetta ei löytynyt"}
//
// > validate({valid: true, foo: 1})
// {valid: true, foo: 1}

function validate(x) {
  if (R.has("valid", x)) return x;
  const validationStatus = x.palautusarvo === 1 ? { valid: true } : { valid: false, error: x.virheteksti };
  return R.merge(R.omit(EXTERNAL_ERROR_KEYS, x), validationStatus);
}
