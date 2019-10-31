'use strict';

const http = require('http');
const child_process = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

async function spawnAsync(cmd, args, options) {
    return new Promise((resolve, reject) => {
        const proc = child_process.spawn(cmd, args, options);
        proc.on('exit', (code) => {
            if (code) {
                return reject(new Error(`Process exited with signal ${code}`));
            }
            resolve(proc);
        });
    });
}

const unlinkAsync = util.promisify(fs.unlink);

const statAsync = util.promisify(fs.stat);
async function existsAsync(file) {
    const stat = await statAsync(file, {});
    return !!stat;
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
    constructor(folder, lang) {
        this.lang = lang;
        this.folder = folder;
        this.shouldRun = false;
        this.child = undefined;

        this.execOptions = {
            cwd: folder,
            stdio: ['inherit', 'inherit', 'inherit'],
            env: {},
        };
    }

    _assignPort() {
        if (this.execOptions.env.PORT) {
            return;
        }

        if (this.lang.allowUnix) {
            return `/srv/sockets/${path.basename(this.folder)}.sock`;
        }

        for (let i = PORTBASE; i < PORTMAX; i++) {
            if (!this.USEDPORTS[i]) {
                this.USEDPORTS[i] = this;
                this.execOptions.env.PORT = i;
                break;
            }
        }
    }

    _unassignPort() {
        if (this.lang.allowUnix || !this.execOptions.env.PORT) {
            return;
        }

        delete USEDPORTS[this.execOptions.env.PORT];
        delete this.execOptions.env.PORT;
    }

    async init() {
        console.log('INIT', this.folder);
        this._unassignPort();

        for (const cmd of this.lang.init) {
            await spawnAsync(cmd[0], cmd[1], this.execOptions);
        }
    }
    
    async start() {
        console.log('START', this.folder);
        
        this.shouldRun = true;
        if (this.child) {
            return;
        }
        
        this.execOptions.env.PORT = this._assignPort();
        if (this.lang.allowUnix && await existsAsync(this.execOptions.env.PORT)) {
            await unlinkAsync(this.execOptions.env.PORT);
        }

        this.child = child_process.spawn(this.lang.run[0], this.lang.run[1], this.execOptions);
        this.child.on('exit', () => {
            this.child = undefined;
            this.restart();
        });
    }

    async stop() {
        console.log('STOP', this.folder);
        this._unassignPort();

        this.shouldRun = false;
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
        await this.stop();
        await this.start();
    }
}

async function runDeploy(repo) {
    if (repo.includes('..') || /[^A-Za-z0-9\._\-]/.test(repo)) {
        throw new Error('Invalid repo name: ' + repo);
    }

    const folder = `/srv/deploy/${repo}`;

    let lang = LANGUAGES.default;
    for (const langName of Object.keys(LANGUAGES)) {
        const langVal = LANGUAGES[langName];
        if (!langVal.file) {
            continue;
        }

        if (await existsAsync(`${folder}/${langVal.file}`)) {
            lang = langVal;
            break;
        }
    }

    let service = SERVICES[repo];
    if (service) {
        await service.stop();
    }
    service = new Service(folder, lang);
    SERVICES[repo] = service;

    await service.init();
    await service.start();
}

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
}).listen(process.env.PORT || 8080);

console.log('Online');
