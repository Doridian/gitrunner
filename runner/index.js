'use strict';

const http = require('http');
const child_process = require('child_process');

const LANGUAGES = {
    nodejs: {
        init: [
            'npm ci',
            'npm run build --if-present',
        ],
        run: 'npm start'
    },
};

const SERVICES = {};

class Service {
    constructor(folder, lang) {
        this.lang = lang;
        this.folder = folder;
        this.shouldRun = false;
        this.child = undefined;
        this.execOptions = {
            cwd: folder,
            stdio: ['inherit', 'inherit', 'inherit'],
        };
    }

    async init() {
        console.log('INIT', this.folder);
        for (const cmd of this.lang.init) {
            child_process.spawnSync(cmd, this.execOptions);
        }
    }
    
    async start() {
        console.log('START', this.folder);
        this.shouldRun = true;
        if (this.child) {
            return;
        }

        this.child = child_process.spawn(this.lang.run, this.execOptions, () => {
            this.child = undefined;
            this.restart();
        });
    }

    async stop() {
        console.log('STOP', this.folder);
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

    const lang = LANGUAGES.nodejs; // TODO: Detect

    let service = SERVICES[repo];
    if (service) {
        await service.stop();
    }
    service = new Service(`/srv/deploy/${repo}`, lang);
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
