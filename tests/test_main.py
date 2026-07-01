import sys
import os
import time
import pytest
from unittest.mock import patch, MagicMock, AsyncMock
from fastapi.testclient import TestClient

# Add project root to python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from server.main import app, localsend_peers, localsend_sessions, MY_FINGERPRINT

client = TestClient(app)

# Dummy test data for Tailscale local API status and targets
MOCK_STATUS_DATA = {
    "Self": {
        "HostName": "my-local-host",
        "DNSName": "my-local-host.tailnet.net",
        "OS": "linux",
        "TailscaleIPs": ["100.64.0.1"]
    },
    "Peer": {
        "nodekey1": {
            "Active": True,
            "CurAddr": "192.168.1.100:41641",
            "Relay": ""
        }
    }
}

MOCK_TARGETS_DATA = [
    {
        "Node": {
            "ID": "node-1",
            "ComputedName": "peer-host-1",
            "Name": "peer-host-1.tailnet.net",
            "Key": "nodekey1",
            "Addresses": ["100.64.0.2/32"],
            "Online": True,
            "Expired": False,
            "Hostinfo": {
                "OS": "android"
            }
        }
    }
]

# 1. Test standard root / SPA wildcard route fallback
def test_spa_wildcard_fallback():
    response = client.get("/some-custom-spa-route")
    # If the static dist folder is not compiled yet in local tests, it should return 404.
    # If dist exists, it should return 200 (serving index.html). Both are expected behavior.
    assert response.status_code in (200, 404)

# 2. Test status endpoint (tailscale + localsend merge)
@patch('server.main.query_local_api')
def test_get_status_success(mock_query):
    # Setup mock for tailscale local API calls
    async def side_effect(path):
        if path == "/localapi/v0/status":
            return MOCK_STATUS_DATA
        elif path == "/localapi/v0/file-targets":
            return MOCK_TARGETS_DATA
        return None
    mock_query.side_effect = side_effect

    # Setup mock localsend peer
    localsend_peers.clear()
    localsend_peers["ls-fingerprint"] = {
        "ip": "192.168.1.50",
        "port": 53317,
        "alias": "My Phone",
        "deviceModel": "Pixel",
        "deviceType": "mobile",
        "fingerprint": "ls-fingerprint",
        "protocol": "http",
        "last_seen": time.time()
    }

    response = client.get("/api/status")
    assert response.status_code == 200
    data = response.json()

    # Assert Self Info
    assert data["self"]["hostName"] == "my-local-host"
    assert data["self"]["ip"] == "100.64.0.1"

    # Assert merged peers list contains Tailscale peer
    ts_peers = [p for p in data["peers"] if not p["id"].startswith("localsend-")]
    assert len(ts_peers) == 1
    assert ts_peers[0]["hostName"] == "peer-host-1"
    assert ts_peers[0]["ip"] == "100.64.0.2"

    # Assert merged peers list contains LocalSend peer
    ls_peers = [p for p in data["peers"] if p["id"].startswith("localsend-")]
    assert len(ls_peers) == 1
    assert ls_peers[0]["hostName"] == "My Phone (LocalSend)"
    assert ls_peers[0]["ip"] == "192.168.1.50"

# 3. Test ping endpoint (Tailscale)
@patch('asyncio.to_thread')
def test_ping_tailscale(mock_to_thread):
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "pinging peer-host-1... via DERP... in 45ms"
    mock_result.stderr = ""
    mock_to_thread.return_value = mock_result

    response = client.get("/api/ping/peer-host-1")
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["latencyMs"] == 45
    assert data["direct"] is False

# 4. Test ping endpoint (LocalSend)
@patch('httpx.AsyncClient.get')
def test_ping_localsend(mock_httpx_get):
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "alias": "My Phone",
        "version": "2.0"
    }
    mock_httpx_get.return_value = mock_response

    localsend_peers["ls-fingerprint"] = {
        "ip": "192.168.1.50",
        "port": 53317,
        "alias": "My Phone",
        "deviceModel": "Pixel",
        "deviceType": "mobile",
        "fingerprint": "ls-fingerprint",
        "protocol": "http",
        "last_seen": time.time()
    }

    response = client.get("/api/ping/localsend-ls-fingerprint")
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert "latencyMs" in data

# 5. Test send endpoint (Tailscale path)
@patch('shutil.copyfile')
@patch('os.remove')
@patch('shutil.rmtree')
@patch('asyncio.to_thread')
def test_send_file_tailscale(mock_to_thread, mock_rmtree, mock_remove, mock_copyfile):
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "Successfully sent"
    mock_result.stderr = ""
    mock_to_thread.return_value = mock_result

    file_content = b"hello unit tests"
    files = {"file": ("test.txt", file_content, "text/plain")}
    data = {"target": "peer-host-1"}

    response = client.post("/api/send", data=data, files=files)
    assert response.status_code == 200
    assert response.json()["success"] is True

# 6. Test send endpoint (LocalSend path)
@patch('server.main.upload_localsend', new_callable=AsyncMock)
@patch('os.remove')
def test_send_file_localsend(mock_remove, mock_upload_localsend):
    localsend_peers["ls-fingerprint"] = {
        "ip": "192.168.1.50",
        "port": 53317,
        "alias": "My Phone",
        "deviceModel": "Pixel",
        "deviceType": "mobile",
        "fingerprint": "ls-fingerprint",
        "protocol": "http",
        "last_seen": time.time()
    }

    file_content = b"hello localsend test"
    files = {"file": ("image.png", file_content, "image/png")}
    data = {"target": "My Phone (LocalSend)"}

    response = client.post("/api/send", data=data, files=files)
    assert response.status_code == 200
    assert response.json()["success"] is True
    mock_upload_localsend.assert_called_once()

# 7. LocalSend Info API
def test_localsend_info_endpoint():
    response = client.get("/api/localsend/v2/info")
    assert response.status_code == 200
    data = response.json()
    assert data["alias"] == "MultiDrop Web Server"
    assert data["fingerprint"] == MY_FINGERPRINT

# 8. LocalSend Register API
def test_localsend_register_endpoint():
    payload = {
        "alias": "Test iPhone",
        "fingerprint": "iphone-fingerprint-777",
        "port": 53317,
        "deviceModel": "iPhone 15",
        "deviceType": "mobile",
        "protocol": "http"
    }
    response = client.post("/api/localsend/v2/register", json=payload)
    assert response.status_code == 200
    assert response.json()["fingerprint"] == MY_FINGERPRINT
    # Verify peer is added to memory store
    assert "iphone-fingerprint-777" in localsend_peers
    assert localsend_peers["iphone-fingerprint-777"]["alias"] == "Test iPhone"

# 9. LocalSend Prepare Upload Handshake API
def test_localsend_prepare_upload_endpoint():
    payload = {
        "info": {
            "alias": "Test iPhone",
            "fingerprint": "iphone-fingerprint-777"
        },
        "files": {
            "fileId-99": {
                "fileName": "avatar.png",
                "size": 500
            }
        }
    }
    response = client.post("/api/localsend/v2/prepare-upload", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "sessionId" in data
    assert "fileId-99" in data["files"]
    
    session_id = data["sessionId"]
    assert session_id in localsend_sessions
    assert localsend_sessions[session_id]["files"]["fileId-99"]["filename"] == "avatar.png"

# 10. LocalSend File Upload Binary API
@patch('shutil.copyfileobj')
def test_localsend_upload_endpoint(mock_copyfileobj):
    # Setup mock active upload session
    session_id = "mock-session-abc"
    token = "mock-token-xyz"
    localsend_sessions[session_id] = {
        "files": {
            "fid-1": {
                "filename": "hello.txt",
                "size": 25,
                "token": token
            }
        }
    }

    file_content = b"some sample content text"
    files = {"file": ("hello.txt", file_content, "text/plain")}

    response = client.post(
        f"/api/localsend/v2/upload?sessionId={session_id}&fileId=fid-1&token={token}",
        files=files
    )
    assert response.status_code == 200
    assert response.json()["success"] is True

# 11. Inbox actions: Download non-existent file
def test_download_file_not_found():
    response = client.get("/api/download/nonexistent-file.pdf")
    assert response.status_code == 404

# 12. Inbox actions: Delete non-existent file
def test_delete_file_not_found():
    response = client.delete("/api/inbox/nonexistent-file.pdf")
    assert response.status_code == 404

# 13. Database initialization test
import sqlite3
import aiosqlite

@pytest.mark.asyncio
async def test_db_initialization(tmp_path):
    test_db_path = os.path.join(tmp_path, "test_history.db")
    from server.main import init_db
    # Call init_db pointing to test database path
    await init_db(test_db_path)
    
    # Assert table exists using sqlite3 connection
    conn = sqlite3.connect(test_db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='transfer_logs';")
    table = cursor.fetchone()
    assert table is not None
    assert table[0] == "transfer_logs"
    conn.close()

# 14. Database connection context manager test
@pytest.mark.asyncio
async def test_get_db_connection(tmp_path):
    test_db_path = os.path.join(tmp_path, "test_history.db")
    from server.main import init_db, get_db_connection
    await init_db(test_db_path)
    
    async with get_db_connection(test_db_path) as db:
        async with db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='transfer_logs';") as cursor:
            row = await cursor.fetchone()
            assert row is not None
            assert row[0] == "transfer_logs"


# 15. Logging helper & log rotation test
@pytest.mark.asyncio
async def test_log_transfer_event(tmp_path):
    test_db_path = os.path.join(tmp_path, "test_history.db")
    from server.main import init_db, log_transfer_event
    await init_db(test_db_path)

    # Test Insertion with path traversal in filename
    log_data = {
        "id": "tx-12345",
        "filename": "../../test_doc.pdf",
        "size": 1000,
        "direction": "send",
        "peer_id": "peer-abc",
        "peer_name": "Test Node",
        "protocol": "LocalSend",
        "status": "in-progress",
        "timestamp": "2026-07-01T12:00:00.000Z"
    }
    await log_transfer_event(log_data, db_path=test_db_path)

    async with aiosqlite.connect(test_db_path) as db:
        async with db.execute("SELECT filename, status FROM transfer_logs WHERE id='tx-12345'") as cursor:
            row = await cursor.fetchone()
            assert row is not None
            # Filename should be sanitized (path traversal removed)
            assert row[0] == "test_doc.pdf"
            assert row[1] == "in-progress"

    # Test Upsert update
    log_data["status"] = "success"
    log_data["speed_bps"] = 500.0
    await log_transfer_event(log_data, db_path=test_db_path)

    async with aiosqlite.connect(test_db_path) as db:
        async with db.execute("SELECT status, speed_bps FROM transfer_logs WHERE id='tx-12345'") as cursor:
            row = await cursor.fetchone()
            assert row[0] == "success"
            assert row[1] == 500.0

    # Test Log rotation / 500 record limit cap
    # We will insert 505 logs. The oldest 5 logs (sorted by timestamp) should be deleted.
    # Note: "tx-12345" has timestamp "2026-07-01T12:00:00.000Z"
    # Let's insert 505 logs.
    # We will generate timestamps like "2026-07-01T12:01:XX.000Z"
    # To check that it correctly deletes the oldest, let's insert 5 logs with older timestamps first:
    # "2026-07-01T11:00:00.000Z", etc.
    # Then insert 500 logs with newer timestamps.
    
    # 1. Clear database first
    async with aiosqlite.connect(test_db_path) as db:
        await db.execute("DELETE FROM transfer_logs;")
        await db.commit()

    # 2. Insert 5 oldest logs
    for i in range(5):
        old_log = {
            "id": f"old-tx-{i}",
            "filename": f"old_file_{i}.txt",
            "size": 100,
            "direction": "send",
            "peer_id": "peer-abc",
            "peer_name": "Test Node",
            "protocol": "LocalSend",
            "status": "success",
            "timestamp": f"2026-07-01T10:00:0{i}.000Z" # Oldest
        }
        await log_transfer_event(old_log, db_path=test_db_path)

    # 3. Insert 500 newer logs (making total 505)
    for i in range(500):
        new_log = {
            "id": f"new-tx-{i}",
            "filename": f"new_file_{i}.txt",
            "size": 200,
            "direction": "receive",
            "peer_id": "peer-xyz",
            "peer_name": "Another Node",
            "protocol": "Taildrop",
            "status": "success",
            "timestamp": f"2026-07-01T12:00:{i:02d}.000Z" if i < 60 else f"2026-07-01T13:00:{i%60:02d}.000Z" # Newer
        }
        await log_transfer_event(new_log, db_path=test_db_path)

    # 4. Verify that total records is capped at 500
    async with aiosqlite.connect(test_db_path) as db:
        async with db.execute("SELECT COUNT(*) FROM transfer_logs") as cursor:
            count_row = await cursor.fetchone()
            assert count_row[0] == 500

        # Verify that the old logs (old-tx-0 to old-tx-4) are deleted
        async with db.execute("SELECT id FROM transfer_logs WHERE id LIKE 'old-tx-%'") as cursor:
            rows = await cursor.fetchall()
            assert len(rows) == 0


# 16. Test History Endpoints
def test_history_endpoints():
    with TestClient(app) as c:
        # Clear history first
        response = c.post("/api/history/clear")
        assert response.status_code == 200
        
        # Get history list (should be empty)
        response = c.get("/api/history")
        assert response.status_code == 200
        assert response.json() == []

# 17. Test Logging Integration on Send
@patch('server.main.upload_localsend', new_callable=AsyncMock)
@patch('os.remove')
def test_send_file_logging_integration(mock_remove, mock_upload_localsend):
    localsend_peers["ls-fingerprint"] = {
        "ip": "192.168.1.50",
        "port": 53317,
        "alias": "My Phone",
        "deviceModel": "Pixel",
        "deviceType": "mobile",
        "fingerprint": "ls-fingerprint",
        "protocol": "http",
        "last_seen": time.time()
    }
    
    with TestClient(app) as c:
        # Clear first
        c.post("/api/history/clear")
        
        file_content = b"hello integration tests"
        files = {"file": ("test_integration.txt", file_content, "text/plain")}
        data = {"target": "My Phone (LocalSend)"}
        
        response = c.post("/api/send", data=data, files=files)
        assert response.status_code == 200
        
        # Verify it was logged in history
        history_resp = c.get("/api/history")
        assert history_resp.status_code == 200
        history_data = history_resp.json()
        assert len(history_data) == 1
        assert history_data[0]["filename"] == "test_integration.txt"
        assert history_data[0]["status"] == "success"
        assert history_data[0]["direction"] == "send"
        assert history_data[0]["protocol"] == "LocalSend"
        assert history_data[0]["peer_name"] == "My Phone (LocalSend)"

# 18. Test Logging Integration on LocalSend Upload
@patch('shutil.copyfileobj')
def test_localsend_upload_logging_integration(mock_copyfileobj):
    # Setup mock active upload session
    session_id = "mock-session-abc-integration"
    token = "mock-token-xyz-integration"
    localsend_sessions[session_id] = {
        "files": {
            "fid-1": {
                "filename": "hello_rec.txt",
                "size": 25,
                "token": token
            }
        }
    }
    
    # Explicitly populate the peer to mock the client registry and resolve state leakage
    localsend_peers.clear()
    localsend_peers["iphone-fingerprint-777"] = {
        "ip": "testclient",
        "port": 53317,
        "alias": "Test iPhone",
        "deviceModel": "iPhone 15",
        "deviceType": "mobile",
        "fingerprint": "iphone-fingerprint-777",
        "protocol": "http",
        "last_seen": time.time()
    }
    
    with TestClient(app) as c:
        # Clear first
        c.post("/api/history/clear")
        
        file_content = b"some sample content text"
        files = {"file": ("hello_rec.txt", file_content, "text/plain")}
        
        response = c.post(
            f"/api/localsend/v2/upload?sessionId={session_id}&fileId=fid-1&token={token}",
            files=files
        )
        assert response.status_code == 200
        
        # Verify it was logged in history
        history_resp = c.get("/api/history")
        assert history_resp.status_code == 200
        history_data = history_resp.json()
        assert len(history_data) == 1
        assert history_data[0]["filename"] == "hello_rec.txt"
        assert history_data[0]["status"] == "success"
        assert history_data[0]["direction"] == "receive"
        assert history_data[0]["protocol"] == "LocalSend"
        assert history_data[0]["peer_name"] == "Test iPhone (LocalSend)"

