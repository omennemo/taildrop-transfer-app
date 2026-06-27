const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Directories
const WORKSPACE_DIR = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.join(WORKSPACE_DIR, 'uploads');
const RECEIVED_DIR = path.join(WORKSPACE_DIR, 'received');

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(RECEIVED_DIR)) {
  fs.mkdirSync(RECEIVED_DIR, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    // Keep original file name but make it unique to avoid collision
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json());

// Serve static files from Angular built directory
const STATIC_DIR = path.join(WORKSPACE_DIR, 'dist/taildrop-app/browser');
app.use(express.static(STATIC_DIR));

// Helper function to query the local tailscaled socket
function queryLocalAPI(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      socketPath: '/var/run/tailscale/tailscaled.sock',
      path: apiPath,
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

// Endpoint: Get status (current node and peers)
app.get('/api/status', async (req, res) => {
  try {
    const statusData = await queryLocalAPI('/localapi/v0/status');
    const targetsData = await queryLocalAPI('/localapi/v0/file-targets');

    const self = {
      hostName: statusData.Self.HostName,
      dnsName: statusData.Self.DNSName,
      os: statusData.Self.OS,
      ip: statusData.Self.TailscaleIPs ? statusData.Self.TailscaleIPs[0] : null,
      online: true
    };

    const peers = (targetsData || []).map(target => {
      const node = target.Node;
      const statusPeer = statusData.Peer ? statusData.Peer[node.Key] : null;

      return {
        id: node.ID,
        hostName: node.ComputedName,
        dnsName: node.Name,
        os: node.Hostinfo ? node.Hostinfo.OS : 'unknown',
        ip: node.Addresses ? node.Addresses[0].split('/')[0] : null,
        online: node.Online,
        expired: node.Expired || false,
        active: statusPeer ? statusPeer.Active : false,
        curAddr: statusPeer ? statusPeer.CurAddr : null,
        relay: statusPeer ? statusPeer.Relay : null
      };
    });

    res.json({ self, peers });
  } catch (error) {
    console.error('Error fetching Tailscale status:', error);
    res.status(500).json({ error: 'Failed to communicate with Tailscale daemon', details: error.message });
  }
});

// Endpoint: Ping a peer to get latency
app.get('/api/ping/:peer', (req, res) => {
  const peer = req.params.peer;
  // Prevent shell injection
  if (!/^[a-zA-Z0-9\-_.]+$/.test(peer)) {
    return res.status(400).json({ error: 'Invalid peer hostname' });
  }

  execFile('tailscale', ['ping', '--c=1', peer], (error, stdout, stderr) => {
    const output = (stdout || '') + (stderr || '');
    
    // Extract latency (e.g. "in 77ms")
    const latencyMatch = output.match(/in (\d+)ms/);
    const latencyMs = latencyMatch ? parseInt(latencyMatch[1], 10) : null;
    
    if (latencyMs !== null) {
      const isDirect = !output.includes('DERP') && !output.includes('relay') && output.includes('via');
      return res.json({
        success: true,
        latencyMs,
        direct: isDirect,
        output: output.trim()
      });
    }

    console.error(`Tailscale ping failed for ${peer}:`, error, output);
    res.status(500).json({
      success: false,
      error: 'Ping failed or timed out',
      details: output.trim()
    });
  });
});


// Endpoint: Send file to a peer
app.post('/api/send', upload.single('file'), (req, res) => {
  const { target } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (!target) {
    // Cleanup file
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: 'No target peer specified' });
  }

  const originalName = file.originalname;
  // We need to copy the file to a temp file with its original name in a subfolder
  // because tailscale file cp uses the actual filename of the file on disk.
  const tempDir = path.join(UPLOADS_DIR, `temp-${Date.now()}`);
  fs.mkdirSync(tempDir);
  const tempFilePath = path.join(tempDir, originalName);

  try {
    fs.copyFileSync(file.path, tempFilePath);
  } catch (err) {
    console.error('Failed to copy file to temp path:', err);
    // Cleanup
    fs.unlinkSync(file.path);
    return res.status(500).json({ error: 'Failed to prepare file for transfer' });
  }

  // Run tailscale file cp
  // Syntax: tailscale file cp <file_path> <target>:
  const targetWithColon = `${target}:`;
  console.log(`Sending file via tailscale file cp ${tempFilePath} ${targetWithColon}`);

  execFile('tailscale', ['file', 'cp', tempFilePath, targetWithColon], (error, stdout, stderr) => {
    // Cleanup temporary files
    try {
      fs.unlinkSync(tempFilePath);
      fs.rmdirSync(tempDir);
      fs.unlinkSync(file.path);
    } catch (cleanupErr) {
      console.error('Error cleaning up files:', cleanupErr);
    }

    if (error) {
      console.error('Tailscale file cp error:', error);
      console.error('Stderr:', stderr);
      return res.status(500).json({
        error: 'Failed to send file via Taildrop',
        details: stderr || error.message
      });
    }

    res.json({ success: true, message: `Successfully sent ${originalName} to ${target}` });
  });
});

// Endpoint: Get received files (runs tailscale file get and reads received folder)
app.get('/api/inbox', (req, res) => {
  // First run tailscale file get to pull any pending files
  execFile('tailscale', ['file', 'get', '--wait=false', RECEIVED_DIR], (error, stdout, stderr) => {
    if (error) {
      console.error('Tailscale file get error (non-fatal):', error, stderr);
      // We still proceed to read whatever is in the received folder
    }

    // Now read the directory
    fs.readdir(RECEIVED_DIR, (err, files) => {
      if (err) {
        console.error('Failed to read received directory:', err);
        return res.status(500).json({ error: 'Failed to read received files' });
      }

      const fileDetails = files.map(filename => {
        const filePath = path.join(RECEIVED_DIR, filename);
        try {
          const stats = fs.statSync(filePath);
          return {
            filename,
            size: stats.size,
            receivedAt: stats.mtime
          };
        } catch (statErr) {
          return {
            filename,
            size: 0,
            receivedAt: new Date()
          };
        }
      });

      // Sort files: newest received first
      fileDetails.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

      res.json(fileDetails);
    });
  });
});

// Endpoint: Download a received file
app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  // Prevent directory traversal
  const safeFilename = path.basename(filename);
  const filePath = path.join(RECEIVED_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, safeFilename, (err) => {
    if (err) {
      console.error('Error downloading file:', err);
    }
  });
});

// Endpoint: Delete a received file
app.delete('/api/inbox/:filename', (req, res) => {
  const filename = req.params.filename;
  const safeFilename = path.basename(filename);
  const filePath = path.join(RECEIVED_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.unlink(filePath, (err) => {
    if (err) {
      console.error('Error deleting file:', err);
      return res.status(500).json({ error: 'Failed to delete file' });
    }
    res.json({ success: true, message: `Successfully deleted ${filename}` });
  });
});

// Endpoint: Extract a received zip file
app.post('/api/extract/:filename', (req, res) => {
  const filename = req.params.filename;
  const safeFilename = path.basename(filename);
  const filePath = path.join(RECEIVED_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (!safeFilename.toLowerCase().endsWith('.zip')) {
    return res.status(400).json({ error: 'Only .zip files can be extracted' });
  }

  const folderName = safeFilename.substring(0, safeFilename.length - 4);
  const extractDestDir = path.join(RECEIVED_DIR, folderName);

  if (!fs.existsSync(extractDestDir)) {
    fs.mkdirSync(extractDestDir, { recursive: true });
  }

  execFile('unzip', ['-o', filePath, '-d', extractDestDir], (error, stdout, stderr) => {
    if (error) {
      console.error('Failed to extract zip file:', error, stderr);
      return res.status(500).json({
        error: 'Extraction failed. Make sure "unzip" is installed on the server.',
        details: stderr || error.message
      });
    }

    res.json({
      success: true,
      message: `Successfully extracted archive to folder "${folderName}"`,
      extractedFolder: folderName
    });
  });
});


// Wildcard route to serve Angular SPA index.html for non-API routes
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  const indexPath = path.join(STATIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Not Found');
  }
});

app.listen(PORT, () => {
  console.log(`Backend server is running on port ${PORT}`);
  console.log(`Received files directory: ${RECEIVED_DIR}`);
  console.log(`Temp uploads directory: ${UPLOADS_DIR}`);
});
