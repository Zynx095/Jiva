import http from 'http';
http.createServer((q, s) => {
  if (q.url.startsWith('/route/v1')) { s.setHeader('content-type','application/json'); s.end(JSON.stringify({code:'Ok',routes:[{distance:12345.6,duration:987.6,geometry:{type:'LineString',coordinates:[[77.597,13.0358],[77.6,13.0],[77.6408,12.9784]]}}]})); }
  else if (q.url.startsWith('/nearest')) { s.end(JSON.stringify({code:'Ok'})); } else { s.statusCode=404; s.end('no'); }
}).listen(5900);
