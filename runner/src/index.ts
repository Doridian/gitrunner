'use strict';

import * as http from 'http';
import * as child_process from 'child_process';
import * as util from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';

const BASEDIR = '/srv/deploy';

async function spawnAsync(cmd: string, args: string[], options: ExecOptions) {
    const pipe = options.pipe;
    if (pipe) {
        delete options.pipe;
    }

    return new Promise((resolve, reject) => {
        const proc = child_process.spawn(cmd, args, options);
        proc.on('exit', (code: number) => {
            if (code) {
                return reject(new Error(`Process exited with signal ${code}`));
            }
            resolve(proc);
        });
        proc.on('error', reject);

        if (pipe) {
            proc.stdout!.pipe(pipe, { end: false });
            proc.stderr!.pipe(pipe, { end: false });
        }
    });
}

const unlinkAsync = util.promisify(fs.unlink);
const existsAsync = util.promisify(fs.exists);

interface Language {
    file?: string;
    init: [string, string[]][];
    run: [string, string[]];
    allowUnix: boolean;
}

const LANGUAGES: {
    [key: string]: Language;
} = {
    nodejs: {
        file: 'package.json',
        init: [
            ['npm', ['ci']],
            ['npm', ['run', 'build', '--if-present']],
        ],
        run: ['npm', ['start']],
        allowUnix: true,
    },
    default: {
        init: [['./init', []]],
        run: ['./run', []],
        allowUnix: true,
    },
};

const SERVICES: {
    [key: string]: Service;
} = {};

const PORTBASE = 40000;
const PORTMAX  = 50000;
const USEDPORTS: {
    [key: string]: Service;
} = {};

type StdioAny = child_process.StdioNull | child_process.StdioPipe;

interface ExecOptions {
    cwd: string;
    stdio: [child_process.StdioNull, StdioAny, StdioAny];
    env: {
        [key: string]: string | undefined;
    };
    pipe?: stream.Writable;
}

class Service {
    private shouldRun = false;
    private child: child_process.ChildProcess | undefined;
    private execOptions: ExecOptions;
    constructor(folder: string, private name: string, private lang: Language) {
        this.execOptions = {
            cwd: folder,
            stdio: ['ignore', 'inherit', 'inherit'],
            env: {
                PATH: process.env.PATH,
                NODE_ENV: 'production',
                ENV: 'production',
            },
        };
    }

    getPort() {
        return this.execOptions.env.PORT;
    }

    setHttpOptions(options: http.RequestOptions) {
        const port = this.getPort();
        if (port !== undefined && isFinite(parseInt(port, 10))) {
            options.host = '127.0.0.1';
            options.port = port;
        } else {
            options.socketPath = port;
        }
    }

    _assignPort(): string {
        if (this.execOptions.env.PORT) {
            return this.execOptions.env.PORT;
        }

        if (this.lang.allowUnix) {
            return `/srv/sockets/${this.name}.sock`;
        }

        for (let i = PORTBASE; i < PORTMAX; i++) {
            if (!USEDPORTS[i]) {
                USEDPORTS[i] = this;
                return i.toString();
            }
        }
        throw new Error('Could not assign port');
    }

    _unassignPort() {
        if (this.lang.allowUnix || !this.execOptions.env.PORT) {
            delete this.execOptions.env.PORT;
            return;
        }

        delete USEDPORTS[this.execOptions.env.PORT];
        delete this.execOptions.env.PORT;
    }

    async init(initStream?: stream.Writable) {
        console.log('INIT', this.name);

        let stdioType: 'inherit' | 'pipe' = 'inherit';
        if (initStream) {
            stdioType = 'pipe';
        }

        for (const cmd of this.lang.init) {
            await spawnAsync(cmd[0], cmd[1], {
                ...this.execOptions,
                stdio: ['ignore', stdioType, stdioType],
                pipe: initStream,
            });
        }
    }

    async start() {
        this.shouldRun = true;
        this.execOptions.env.PORT = this._assignPort();
        await this._start();
    }

    async stop() {
        this.shouldRun = false;
        await this._stop();
        this._unassignPort();
    }
    
    async _start() {
        if (!this.shouldRun || this.child) {
            return;
        }

        console.log('START', this.name);
        
        if (this.lang.allowUnix && await existsAsync(this.execOptions.env.PORT!)) {
            await unlinkAsync(this.execOptions.env.PORT!);
        }

        const child = child_process.spawn(this.lang.run[0], this.lang.run[1], this.execOptions);
        this.child = child;

        const self = this;
        function _onExit() {
            if (self.child !== child) {
                return;
            }
            self.child = undefined;
            self.restart();
        }

        function onExit() {
            setTimeout(_onExit, 1000);
        }


        child.on('exit', onExit);
        child.on('error', onExit);
    }

    async _stop() {
        console.log('STOP', this.name);

        if (this.child) {
            this.child.kill();
            this.child = undefined;
        }
    }
    
    async _check() {
        return new Promise((resolve, reject) => {
            const options = {
                path: '/healthcheck',
                timeout: 1000,
            };
            this.setHttpOptions(options);
            const req = http.get(options, (res) => {
                if (res.statusCode! >= 500) {
                    return reject(new Error(`Response code ${res.statusCode}`));
                }
                resolve();
            });
            req.on('error', reject);
        });
    }

    async check() {
        if (!this.shouldRun) {
            return;
        }

        try {
            await this._check();
        } catch (e) { 
            console.error('Error checking service', this.name, e.stack || e);
            await this.restart();
        }
    }

    async restart() {
        await this._stop();
        await this._start();
    }
}

async function runDeploy(repo: string, stream?: stream.Writable) {
    if (repo === '.' || repo.includes('..') || /[^A-Za-z0-9\._\-]/.test(repo)) {
        throw new Error('Invalid repo name: ' + repo);
    }

    const folder = path.join(BASEDIR, repo);
    const name = repo.replace(/\.git$/, '');

    let lang = LANGUAGES.default;
    for (const langName of Object.keys(LANGUAGES)) {
        const langVal = LANGUAGES[langName];
        if (!langVal.file) {
            continue;
        }

        if (await existsAsync(path.join(folder, langVal.file))) {
            console.log('Detected runtime', langName);
            lang = langVal;
            break;
        }
    }

    let service = SERVICES[name];
    if (service) {
        await service.stop();
    }
    service = new Service(folder, name, lang);
    SERVICES[name] = service;

    await service.init(stream);
    await service.start();
}

console.log('Scanning old directories...');
const dirs = fs.readdirSync(BASEDIR);
for (const dir of dirs) {
    runDeploy(dir).catch(e => console.error(e));
}

try {
    fs.unlinkSync('/tmp/gitdeploy-master.sock');
} catch { }

class ProxyStream extends stream.Writable {
    public data: string = '';

    _write(chunk: Buffer, _encoding: string, cb: () => void) {
        this.data += chunk.toString();
        cb();
    }
}

http.createServer((req, res) => {
    const stream = new ProxyStream();

    runDeploy(req.url!.substr(1), stream)
    .then(() => {
        stream.end();

        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.write(stream.data);
        res.end();
    }, err => {
        stream.end();

        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.write(err.stack || err);
        res.write('\n\n\n');
        res.write(stream.data);
        res.end();
    });
}).listen('/tmp/gitdeploy-master.sock');

http.createServer((req, res) => {
    const host = req.headers.host;
    if (!host) {
        res.writeHead(400);
        res.end();
        return;
    }

    const service = SERVICES[host.split('.')[0]];
    if (!service) {
        res.writeHead(404);
        res.end();
        return;
    }

    const innerOptions: http.RequestOptions = {
        path: req.url,
        headers: req.headers,
        method: req.method,
        setHost: false,
        timeout: 10000,
    };

    service.setHttpOptions(innerOptions);

    const innerReq = http.request(innerOptions, (innerRes) => {
        res.writeHead(innerRes.statusCode!, innerRes.headers);
        innerRes.pipe(res);
    });

    innerReq.on('error', e => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.write(e.stack || e);
        res.end();
    });

    req.pipe(innerReq);
}).listen(8000, '0.0.0.0');

console.log('Online.');

async function runChecks() {
    for (const serviceName of Object.keys(SERVICES)) {
        const service = SERVICES[serviceName];
        try {
            await service.check();
        } catch(e) {
            console.error('Error checking service', serviceName, e.stack || e);
        }
    }
    setTimeout(runChecks, 30000);
}

runChecks();
