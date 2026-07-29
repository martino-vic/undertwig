"use strict";
/********************************************************************************
 * Copyright (C) 2019 Elliott Wen.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
/* Undertwig Android: real Web Worker path (same as mobile Chrome / undertwig.com). */
var exports = {};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
exports.__esModule = true;
exports.PdfTeXEngine = exports.CompileResult = exports.EngineStatus = void 0;
var EngineStatus;
(function (EngineStatus) {
    EngineStatus[EngineStatus["Init"] = 1] = "Init";
    EngineStatus[EngineStatus["Ready"] = 2] = "Ready";
    EngineStatus[EngineStatus["Busy"] = 3] = "Busy";
    EngineStatus[EngineStatus["Error"] = 4] = "Error";
})(EngineStatus = exports.EngineStatus || (exports.EngineStatus = {}));
var ENGINE_PATH = './swiftlatexpdftex.js?v=8';
var CompileResult = /** @class */ (function () {
    function CompileResult() {
        this.pdf = undefined;
        this.status = -254;
        this.log = 'No log';
        this.aux = {};
    }
    return CompileResult;
}());
exports.CompileResult = CompileResult;
var PdfTeXEngine = /** @class */ (function () {
    function PdfTeXEngine() {
        this.latexWorker = undefined;
        this.latexWorkerStatus = EngineStatus.Init;
    }
    PdfTeXEngine.prototype.loadEngine = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (this.latexWorker !== undefined) {
                            throw new Error('Other instance is running, abort()');
                        }
                        this.latexWorkerStatus = EngineStatus.Init;
                        return [4 /*yield*/, new Promise(function (resolve, reject) {
                                var workerUrl = new URL(ENGINE_PATH, window.location.href).href;
                                _this.latexWorker = new Worker(workerUrl);
                                _this.latexWorker.onmessage = function (ev) {
                                    var data = ev['data'];
                                    var cmd = data['result'];
                                    if (cmd === 'ok') {
                                        _this.latexWorkerStatus = EngineStatus.Ready;
                                        resolve();
                                    }
                                    else {
                                        _this.latexWorkerStatus = EngineStatus.Error;
                                        reject(new Error('PdfTeX worker failed to initialize'));
                                    }
                                };
                                _this.latexWorker.onerror = function (err) {
                                    _this.latexWorkerStatus = EngineStatus.Error;
                                    reject(err && err.message ? err : new Error('PdfTeX worker error'));
                                };
                            })];
                    case 1:
                        _a.sent();
                        this.latexWorker.onmessage = function (_) {
                        };
                        this.latexWorker.onerror = function (_) {
                        };
                        return [2 /*return*/];
                }
            });
        });
    };
    PdfTeXEngine.prototype.isReady = function () {
        return this.latexWorkerStatus === EngineStatus.Ready;
    };
    PdfTeXEngine.prototype.checkEngineStatus = function () {
        if (!this.isReady()) {
            throw Error('Engine is still spinning or not ready yet!');
        }
    };
    PdfTeXEngine.prototype.compileLaTeX = function () {
        return __awaiter(this, void 0, void 0, function () {
            var start_compile_time, res;
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        this.checkEngineStatus();
                        this.latexWorkerStatus = EngineStatus.Busy;
                        start_compile_time = performance.now();
                        return [4 /*yield*/, new Promise(function (resolve, _) {
                                _this.latexWorker.onmessage = function (ev) {
                                    var data = ev['data'];
                                    var cmd = data['cmd'];
                                    if (cmd !== "compile")
                                        return;
                                    var result = data['result'];
                                    var log = data['log'];
                                    var status = data['status'];
                                    _this.latexWorkerStatus = EngineStatus.Ready;
                                    console.log('Engine compilation finish ' + (performance.now() - start_compile_time));
                                    var nice_report = new CompileResult();
                                    nice_report.status = status;
                                    nice_report.log = log;
                                    nice_report.aux = data['aux'] || {};
                                    if (result === 'ok') {
                                        var pdf = new Uint8Array(data['pdf']);
                                        nice_report.pdf = pdf;
                                    }
                                    resolve(nice_report);
                                };
                                _this.latexWorker.postMessage({ 'cmd': 'compilelatex' });
                                console.log('Engine compilation start');
                            })];
                    case 1:
                        res = _a.sent();
                        this.latexWorker.onmessage = function (_) {
                        };
                        return [2 /*return*/, res];
                }
            });
        });
    };
    PdfTeXEngine.prototype.compileFormat = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        this.checkEngineStatus();
                        this.latexWorkerStatus = EngineStatus.Busy;
                        return [4 /*yield*/, new Promise(function (resolve, reject) {
                                _this.latexWorker.onmessage = function (ev) {
                                    var data = ev['data'];
                                    var cmd = data['cmd'];
                                    if (cmd !== "compile")
                                        return;
                                    var result = data['result'];
                                    var log = data['log'];
                                    _this.latexWorkerStatus = EngineStatus.Ready;
                                    if (result === 'ok') {
                                        var formatArray = data['pdf'];
                                        var formatBlob = new Blob([formatArray], { type: 'application/octet-stream' });
                                        var formatURL_1 = URL.createObjectURL(formatBlob);
                                        setTimeout(function () { URL.revokeObjectURL(formatURL_1); }, 30000);
                                        console.log('Download format file via ' + formatURL_1);
                                        resolve();
                                    }
                                    else {
                                        reject(log);
                                    }
                                };
                                _this.latexWorker.postMessage({ 'cmd': 'compileformat' });
                            })];
                    case 1:
                        _a.sent();
                        this.latexWorker.onmessage = function (_) {
                        };
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Install a TeX format into the worker FS.
     * Prefer a same-origin URL so the worker loads the ~10MB .fmt itself
     * (avoids cloning large buffers through postMessage).
     */
    PdfTeXEngine.prototype.preloadTexFile = function (name, dataOrUrl) {
        var _this = this;
        this.checkEngineStatus();
        return new Promise(function (resolve, reject) {
            if (_this.latexWorker === undefined) {
                reject(new Error('preloadtex: worker missing'));
                return;
            }
            _this.latexWorkerStatus = EngineStatus.Busy;
            _this.latexWorker.onmessage = function (ev) {
                var data = ev['data'];
                if (!data || data['cmd'] !== 'preloadtex') {
                    return;
                }
                _this.latexWorkerStatus = EngineStatus.Ready;
                _this.latexWorker.onmessage = function (_) { };
                if (data['result'] === 'ok') {
                    resolve();
                }
                else {
                    reject(new Error(data['log'] || 'preloadtex failed'));
                }
            };
            if (typeof dataOrUrl === 'string') {
                _this.latexWorker.postMessage({
                    cmd: 'preloadtex',
                    name: name,
                    url: dataOrUrl,
                });
                return;
            }
            var bytes;
            if (dataOrUrl instanceof ArrayBuffer) {
                bytes = new Uint8Array(dataOrUrl);
            }
            else if (dataOrUrl && dataOrUrl.byteLength !== undefined) {
                bytes = dataOrUrl instanceof Uint8Array
                    ? dataOrUrl
                    : new Uint8Array(dataOrUrl.buffer, dataOrUrl.byteOffset || 0, dataOrUrl.byteLength);
            }
            else {
                _this.latexWorkerStatus = EngineStatus.Ready;
                reject(new Error('preloadTexFile: expected URL or binary data'));
                return;
            }
            var copy = bytes.slice();
            _this.latexWorker.postMessage(
                { cmd: 'preloadtex', name: name, data: copy.buffer },
                [copy.buffer]
            );
        });
    };
    PdfTeXEngine.prototype.setEngineMainFile = function (filename) {
        this.checkEngineStatus();
        if (this.latexWorker !== undefined) {
            this.latexWorker.postMessage({ 'cmd': 'setmainfile', 'url': filename });
        }
    };
    PdfTeXEngine.prototype.writeMemFSFile = function (filename, srccode) {
        this.checkEngineStatus();
        if (this.latexWorker !== undefined) {
            this.latexWorker.postMessage({ 'cmd': 'writefile', 'url': filename, 'src': srccode });
        }
    };
    PdfTeXEngine.prototype.makeMemFSFolder = function (folder) {
        this.checkEngineStatus();
        if (this.latexWorker !== undefined) {
            if (folder === '' || folder === '/') {
                return;
            }
            this.latexWorker.postMessage({ 'cmd': 'mkdir', 'url': folder });
        }
    };
    PdfTeXEngine.prototype.flushCache = function () {
        this.checkEngineStatus();
        if (this.latexWorker !== undefined) {
            this.latexWorker.postMessage({ 'cmd': 'flushcache' });
        }
    };
    PdfTeXEngine.prototype.setTexliveEndpoint = function (url) {
        if (this.latexWorker !== undefined) {
            this.latexWorker.postMessage({ 'cmd': 'settexliveurl', 'url': url });
            this.latexWorker = undefined;
        }
    };
    PdfTeXEngine.prototype.closeWorker = function () {
        if (this.latexWorker !== undefined) {
            try {
                this.latexWorker.postMessage({ 'cmd': 'grace' });
            }
            catch (_e) { }
            try {
                this.latexWorker.terminate();
            }
            catch (_e2) { }
            this.latexWorker = undefined;
        }
    };
    return PdfTeXEngine;
}());
exports.PdfTeXEngine = PdfTeXEngine;

;window.PdfTeXEngine = exports.PdfTeXEngine;
