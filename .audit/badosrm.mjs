import http from 'http';
let n = 0;
http.createServer((q, s) => { n++; s.setHeader('content-type', 'application/json'); s.end(n % 2 ? '{not json' : JSON.stringify({ code: 'Ok', routes: [] })); }).listen(5901);
