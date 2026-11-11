import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const code = ts.transpileModule(readFileSync("src/lib/airlines.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const api = {};
runInNewContext(code, { exports: api });
assert.ok(api.AIRLINES.length >= 100);
assert.equal(new Set(api.AIRLINES.map(a => a.iata)).size, api.AIRLINES.length);
for (const airline of api.AIRLINES) {
  assert.match(airline.iata, /^[A-Z0-9]{2}$/);
  assert.equal(api.resolveAirline(airline.name).iata, airline.iata);
  assert.equal(api.resolveAirline(airline.iata).iata, airline.iata);
  assert.equal(api.resolveAirline(airline.nameEn).iata, airline.iata);
  assert.equal(api.completeFlightNumber("001", airline.name), `${airline.iata}001`);
  assert.equal(api.flightNumberInput(`${airline.iata}001`, airline.name), "001");
}
for (const [query, iata] of [["ANA", "NH"], ["全日空", "NH"], ["国泰", "CX"], ["美联航", "UA"], ["長榮航空", "BR"], ["春秋", "9C"], ["靛蓝", "6E"], ["Air France", "AF"], ["starLux", "JX"]]) assert.equal(api.resolveAirline(query).iata, iata);
assert.ok(api.searchAirlines("亚洲航空").length >= 3);
assert.ok(api.searchAirlines("delta").some(a => a.iata === "DL"));
assert.ok(api.searchAirlines("").length <= 12);
for (const [input, airline, output] of [["105", "ANA", "NH105"], ["００１", "国泰", "CX001"], ["123A", "春秋", "9C123A"], ["nh 105", "ANA", "NH105"], ["UA105", "ANA", "UA105"], ["9C001", "ANA", "9C001"], ["6E001", "靛蓝", "6E001"], ["", "ANA", ""], ["105", "未收录航空", "105"], ["ZZ105", "未收录航空", "ZZ105"]]) assert.equal(api.completeFlightNumber(input, airline), output);
assert.equal(api.flightNumberInput("NH105", "United Airlines"), "NH105");
assert.equal(api.isCompleteFlightNumber("105"), false);
assert.equal(api.isCompleteFlightNumber("NH"), false);
assert.equal(api.isCompleteFlightNumber("12345"), false);
assert.equal(api.isCompleteFlightNumber("6E001"), true);
assert.equal(api.isCompleteFlightNumber("9C123A"), true);
console.log(`PASS: ${api.AIRLINES.length} airline mappings, alias search, numeric/alphanumeric codes, leading zeros, full-number preservation and input validation.`);
