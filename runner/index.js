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
            stdio: ['inherit', 'inherit', 'inherit'],
            env: {
                PATH: process.env.PATH,
                NODE_ENV: 'production',
            },
        };
    }

    getPort() {
        return this.execOptions.env.PORT;
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

    async init() {
        console.log('INIT', this.name);
        for (const cmd of this.lang.init) {
            await spawnAsync(cmd[0], cmd[1], this.execOptions);
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
        function onExit() {
            if (self.child !== child) {
                return;
            }
            self.child = undefined;
            self.restart();
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

    async check() { // TODO: Globally loop through all
        if (!this.shouldRun) {
            return;
        }
    }

    async restart() {
        await this._stop();
        await this._start();
    }
}

async function runDeploy(repo) {
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

    await service.init();
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

http.createServer((req, res) => {
    runDeploy(req.url.substr(1))
    .then(() => {
        res.writeHead(204);
        res.end();
    }, err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.write(err.stack || err);
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

    const port = service.getPort();

    const innerOptions = {
        path: req.url,
        headers: req.headers,
        method: req.method,
        setHost: false,
    };

    if (isFinite(port)) {
        innerOptions.host = '127.0.0.1';
        innerOptions.port = port;
    } else {
        innerOptions.socketPath = port;
    }

    const innerReq = http.request(innerOptions, (innerRes) => {
        res.writeHead(innerRes.statusCode, innerRes.headers);
        innerRes.pipe(res);
    });

    req.pipe(innerReq);
}).listen(8000, '0.0.0.0');

console.log('Online.');
