import net from 'net';
for (const p of [8002,5000]) net.createServer(s => { s.on('error',()=>{}); }).listen(p);
