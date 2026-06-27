const http = require('http');

function queryLocalAPI(path) {
  return new Promise((resolve, reject) => {
    const options = {
      socketPath: '/var/run/tailscale/tailscaled.sock',
      path: path,
      method: 'GET',
      headers: {
        'Host': 'local-tailscaled.sock'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        } else {
          reject(new Error(`LocalAPI returned status ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

queryLocalAPI('/localapi/v0/status')
  .then(status => {
    console.log('Self HostName:', status.Self.HostName);
    console.log('Self IP:', status.Self.TailscaleIPs[0]);
  })
  .catch(err => {
    console.error('Error:', err);
  });
