'use strict';

const http = require('http');
const child_process = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

const BASEDIR = '/srv/deploy';

async function spawnAsync(cmd, args, options) {
    return new Promise((resolve, reject) => {
        const proc = child_process.spawn(cmd, args, options);
        proc.on('exit', (code) => {
            if (code) {
                return reject(new Error(`Process exited with signal ${code}`));
            }
            resolve(proc);
        });
        proc.on('error', reject);
    });
}

const unlinkAsync = util.promisify(fs.unlink);

const statAsync = util.promisify(fs.stat);
async function existsAsync(file) {
    try {
        const stat = await statAsync(file, {});
        return !!stat;
    } catch(e) {
        if (e && e.code === 'ENOENT') {
            return false;
        }
        throw e;
    }
}

const LANGUAGES = {
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
        init: [['./init'], []],
        run: ['./run', []],
        allowUnix: true,
    },
};

const SERVICES = {};

const PORTBASE = 40000;
const PORTMAX  = 50000;
const USEDPORTS = {};

class Service {
    constructor(folder, name, lang) {
        this.lang = lang;
        this.folder = folder;
        this.name = name;
        this.shouldRun = false;
        this.child = undefined;

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

    setHttpOptions(options) {
        const port = this.getPort();
        if (isFinite(port)) {
            options.host = '127.0.0.1';
            options.port = port;
        } else {
            options.socketPath = port;
        }
    }

    _assignPort() {
        if (this.execOptions.env.PORT) {
            return this.execOptions.env.PORT;
        }

        if (this.lang.allowUnix) {
            return `/srv/sockets/${this.name}.sock`;
        }

        for (let i = PORTBASE; i < PORTMAX; i++) {
            if (!this.USEDPORTS[i]) {
                this.USEDPORTS[i] = this;
                return i;
            }
        }
    }

    _unassignPort() {
        if (this.lang.allowUnix || !this.execOptions.env.PORT) {
            delete this.execOptions.env.PORT;
            return;
        }

        delete USEDPORTS[this.execOptions.env.PORT];
        delete this.execOptions.env.PORT;
    }

    async init(initStream) {
        console.log('INIT', this.name);

        for (const cmd of this.lang.init) {
            await spawnAsync(cmd[0], cmd[1], {
                ...this.execOptions,
                stdiot: ['ignore', initStream, initStream],
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
        
        if (this.lang.allowUnix && await existsAsync(this.execOptions.env.PORT)) {
            await unlinkAsync(this.execOptions.env.PORT);
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
            };
            this.setHttpOptions(options);
            const req = http.get(options, (res) => {
                if (res.statusCode >= 500) {
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

async function runDeploy(repo, res) {
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

    await service.init(res);
    await service.start();
}

console.log('Scanning old directories...');
const dirs = fs.readdirSync(BASEDIR);
for (const dir of dirs) {
    runDeploy(dir, 'inherit').catch(e => console.error(e));
}

try {
    fs.unlinkSync('/tmp/gitdeploy-master.sock');
} catch { }

http.createServer((req, res) => {
    const stream = new WritableStream();
    let data = '';
    stream.on('data', chunk => {
        data += chunk;
    });

    runDeploy(req.url.substr(1), stream)
    .then(() => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.write(stream);
        res.end();
    }, err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.write(err.stack || err);
        res.write('\n');
        res.write(data);
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

    const innerOptions = {
        path: req.url,
        headers: req.headers,
        method: req.method,
        setHost: false,
    };

    service.setHttpOptions(innerOptions);

    const innerReq = http.request(innerOptions, (innerRes) => {
        res.writeHead(innerRes.statusCode, innerRes.headers);
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
