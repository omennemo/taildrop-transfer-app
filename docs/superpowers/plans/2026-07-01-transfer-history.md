# Transfer History & Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a persistent transfer history log in a local SQLite database that records successful/failed file transfers with calculated speeds, and display them in a collapsible glassmorphic panel in the frontend queue, enabling safe retry validations.

**Architecture:** 
- The FastAPI backend interacts asynchronously with a local database (`transfer_history.db`) using `aiosqlite`.
- Database operations are non-blocking, and WAL mode is activated for concurrency safety.
- The Angular 22 frontend polls logs every 5 seconds, renders a collapsible table, and handles retry file matching before queuing transfers.

**Tech Stack:** FastAPI, aiosqlite, Angular 22, sqlite3, pytest-asyncio

## Global Constraints
- Naming scheme: `transfer_logs` for database table, `aiosqlite` for database connection, `/api/history` for logs retrieval, `/api/history/clear` for clearing.
- All absolute file paths must be sanitized to base filenames using `os.path.basename` before logging or saving.
- History list returned by backend is limited to the latest 500 rows, sorted by timestamp descending.

---

### Task 1: Setup aiosqlite & Database Scaffolding

**Files:**
- Modify: `requirements.txt`
- Modify: `server/main.py:1-35` (imports & db setup)
- Modify: `tests/test_main.py` (add database tests)

**Interfaces:**
- Consumes: None
- Produces: `init_db()` and async database connection pool `get_db_connection()`

- [ ] **Step 1: Write the failing test**

In `tests/test_main.py`, add a test that verifies `init_db` initializes the SQLite database table structure:
```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
.venv/bin/pytest tests/test_main.py -k test_db_initialization
```
Expected: FAIL with `ImportError` or `AttributeError: init_db not found`

- [ ] **Step 3: Write minimal implementation**

First, append `aiosqlite>=0.20.0` to `requirements.txt`.
Then, in `server/main.py`, add imports and write `init_db`:
```python
import aiosqlite

DB_PATH = os.path.join(WORKSPACE_DIR, "transfer_history.db")

async def init_db(db_path=DB_PATH):
    async with aiosqlite.connect(db_path) as db:
        await db.execute("PRAGMA journal_mode=WAL;")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS transfer_logs (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                size INTEGER NOT NULL,
                direction TEXT CHECK(direction IN ('send', 'receive')) NOT NULL,
                peer_id TEXT NOT NULL,
                peer_name TEXT NOT NULL,
                protocol TEXT CHECK(protocol IN ('Taildrop', 'LocalSend')) NOT NULL,
                status TEXT CHECK(status IN ('success', 'failed', 'in-progress')) NOT NULL,
                timestamp TEXT NOT NULL,
                speed_bps REAL,
                duration_ms INTEGER,
                error_msg TEXT
            );
        """)
        await db.commit()
```
Call `await init_db()` in the FastAPI lifespan startup event block:
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: init database, start UDP listener, broadcast presence
    await init_db()
    start_udp_listener()
    broadcast_presence()
    yield
```

- [ ] **Step 4: Run test to verify it passes**

Install dependency:
```bash
.venv/bin/pip install aiosqlite
```
Run:
```bash
.venv/bin/pytest tests/test_main.py -k test_db_initialization
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add requirements.txt server/main.py tests/test_main.py
git commit -m "feat: add aiosqlite dependency and database initialization"
```

---

### Task 2: Implement logging helper & log rotation

**Files:**
- Modify: `server/main.py`
- Modify: `tests/test_main.py`

**Interfaces:**
- Consumes: `init_db()`
- Produces: `async def log_transfer_event(log: dict) -> None`

- [ ] **Step 1: Write the failing test**

In `tests/test_main.py`, add a test to verify logging inserts a record, logs are updated on upsert, and logs are capped at 500 records:
```python
@pytest.mark.asyncio
async def test_log_transfer_event(tmp_path):
    test_db_path = os.path.join(tmp_path, "test_history.db")
    from server.main import init_db, log_transfer_event
    await init_db(test_db_path)

    # Test Insertion
    log_data = {
        "id": "tx-12345",
        "filename": "test_doc.pdf",
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
.venv/bin/pytest tests/test_main.py -k test_log_transfer_event
```
Expected: FAIL with `AttributeError` for `log_transfer_event`

- [ ] **Step 3: Write minimal implementation**

In `server/main.py`, implement `log_transfer_event`:
```python
async def log_transfer_event(log: dict, db_path=DB_PATH):
    # Sanitize path traversal in filenames
    filename = os.path.basename(log.get("filename", "unknown"))
    
    async with aiosqlite.connect(db_path) as db:
        await db.execute("""
            INSERT INTO transfer_logs (
                id, filename, size, direction, peer_id, peer_name, 
                protocol, status, timestamp, speed_bps, duration_ms, error_msg
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                status=excluded.status,
                speed_bps=excluded.speed_bps,
                duration_ms=excluded.duration_ms,
                error_msg=excluded.error_msg;
        """, (
            log["id"], filename, log["size"], log["direction"], log["peer_id"], log["peer_name"],
            log["protocol"], log["status"], log["timestamp"], log.get("speed_bps"),
            log.get("duration_ms"), log.get("error_msg")
        ))
        
        # Enforce 500 limit cap (Delete oldest rows outside limit)
        await db.execute("""
            DELETE FROM transfer_logs WHERE id NOT IN (
                SELECT id FROM transfer_logs ORDER BY timestamp DESC LIMIT 500
            );
        """)
        await db.commit()
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
.venv/bin/pytest tests/test_main.py -k test_log_transfer_event
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/main.py tests/test_main.py
git commit -m "feat: implement log_transfer_event with SQLite UPSERT and log cap pruning"
```

---

### Task 3: Backend API Endpoints & Hooks

**Files:**
- Modify: `server/main.py`
- Modify: `tests/test_main.py`

**Interfaces:**
- Consumes: `log_transfer_event()`
- Produces: API routes `GET /api/history` and `POST /api/history/clear`

- [ ] **Step 1: Write the failing test**

In `tests/test_main.py`, write tests that check the GET and POST API endpoints for history logs:
```python
def test_history_endpoints():
    # Clear history first
    response = client.post("/api/history/clear")
    assert response.status_code == 200
    
    # Get history list (should be empty)
    response = client.get("/api/history")
    assert response.status_code == 200
    assert response.json() == []
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
.venv/bin/pytest tests/test_main.py -k test_history_endpoints
```
Expected: FAIL with `404` status code on `/api/history`

- [ ] **Step 3: Write minimal implementation**

In `server/main.py`, define endpoints and connect them to SQLite:
```python
@app.get("/api/history")
async def get_history():
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT * FROM transfer_logs ORDER BY timestamp DESC LIMIT 500") as cursor:
                rows = await cursor.fetchall()
                return [dict(r) for r in rows]
    except Exception as e:
        print(f"Failed to read history logs: {e}")
        return []

@app.post("/api/history/clear")
async def clear_history():
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute("DELETE FROM transfer_logs;")
            await db.commit()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to clear history: {str(e)}")
```

Now, hook `log_transfer_event` into the file transfer pathways.
In `server/main.py`, find the LocalSend upload handler `/api/localsend/v2/upload`:
Update `localsend_upload(...)` to record the transfer start and completion:
```python
    tx_id = f"tx-{int(time.time() * 1000)}-{random.randint(1000, 9999)}"
    start_time = time.time()
    
    # Log incoming transfer as in-progress
    log_data = {
        "id": tx_id,
        "filename": file_info["filename"],
        "size": file_info["size"],
        "direction": "receive",
        "peer_id": "localsend-unknown", # fallback, will resolve if registration matches
        "peer_name": "LocalSend Peer",
        "protocol": "LocalSend",
        "status": "in-progress",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    # Resolve actual registered peer if present
    for p in localsend_peers.values():
        if p["ip"] == request.client.host:
            log_data["peer_id"] = f"localsend-{p['fingerprint']}"
            log_data["peer_name"] = f"{p['alias']} (LocalSend)"
            break
            
    await log_transfer_event(log_data)
    
    # Save file...
    try:
        with open(dest_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        # Log success
        duration = int((time.time() - start_time) * 1000)
        speed = file_info["size"] / (duration / 1000.0) if duration > 0 else 0
        log_data["status"] = "success"
        log_data["speed_bps"] = speed
        log_data["duration_ms"] = duration
        await log_transfer_event(log_data)
    except Exception as e:
        # Log failure
        log_data["status"] = "failed"
        log_data["error_msg"] = str(e)
        await log_transfer_event(log_data)
        raise HTTPException(status_code=500, detail="Failed to save file")
```

Also, in `server/main.py`, update `send_file(...)` to log client uploads:
```python
    # For sends (Tailscale/LocalSend)
    tx_id = f"tx-{int(time.time() * 1000)}-{random.randint(1000, 9999)}"
    start_time = time.time()
    log_data = {
        "id": tx_id,
        "filename": file.filename,
        "size": file_size,
        "direction": "send",
        "peer_id": target,
        "peer_name": target,
        "protocol": "Taildrop",
        "status": "in-progress",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    
    if ls_peer:
        log_data["peer_id"] = f"localsend-{ls_peer['fingerprint']}"
        log_data["peer_name"] = f"{ls_peer['alias']} (LocalSend)"
        log_data["protocol"] = "LocalSend"
        
    await log_transfer_event(log_data)
    
    # Run the actual upload (Localsend or Tailscale cp)
    try:
        if ls_peer:
            await upload_localsend(ls_peer, upload_file_path, file.filename, file_size, file.content_type)
        else:
            # ... tailscale execution block ...
            result = await asyncio.to_thread(subprocess.run, ...)
            if result.returncode != 0:
                raise Exception(result.stderr or "Process failed")
                
        # Log Success
        duration = int((time.time() - start_time) * 1000)
        speed = file_size / (duration / 1000.0) if duration > 0 else 0
        log_data["status"] = "success"
        log_data["speed_bps"] = speed
        log_data["duration_ms"] = duration
        await log_transfer_event(log_data)
    except Exception as e:
        # Log failure
        log_data["status"] = "failed"
        log_data["error_msg"] = str(e)
        await log_transfer_event(log_data)
        raise HTTPException(status_code=500, detail=str(e))
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
.venv/bin/pytest tests/test_main.py -k test_history_endpoints
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/main.py tests/test_main.py
git commit -m "feat: implement GET/POST API endpoints and hook logging into transfer pathways"
```

---

### Task 4: Frontend Service Integration

**Files:**
- Modify: `src/app/taildrop.service.ts`

**Interfaces:**
- Consumes: None
- Produces: `getHistory()` and `clearHistory()` methods

- [ ] **Step 1: Write a failing compilation check**

Open `src/app/taildrop.service.ts` and verify it has no history methods. If you attempted to call `getHistory` from another file, compilation would fail:
```typescript
// Compilation check: expect compiler error if method called on service
const service = new TaildropService();
service.getHistory(); // should compile fail before modification
```

- [ ] **Step 2: Add interface and service methods**

In `src/app/taildrop.service.ts`, define the new interface and methods:
```typescript
export interface TransferLog {
  id: string;
  filename: string;
  size: number;
  direction: 'send' | 'receive';
  peer_id: string;
  peer_name: string;
  protocol: 'Taildrop' | 'LocalSend';
  status: 'success' | 'failed' | 'in-progress';
  timestamp: string;
  speed_bps: number | null;
  duration_ms: number | null;
  error_msg: string | null;
}

// In class TaildropService:
getHistory(): Observable<TransferLog[]> {
  return this.http.get<TransferLog[]>('/api/history');
}

clearHistory(): Observable<{ success: boolean }> {
  return this.http.post<{ success: boolean }>('/api/history/clear', {});
}
```

- [ ] **Step 3: Verify it compiles successfully**

Run:
```bash
npm run build
```
Expected: Successful compile of Angular project.

- [ ] **Step 4: Commit**

```bash
git add src/app/taildrop.service.ts
git commit -m "feat: add getHistory and clearHistory service HTTP wrappers"
```

---

### Task 5: Frontend UI & Collapsible History Panel

**Files:**
- Modify: `src/app/app.ts`
- Modify: `src/app/app.html`
- Modify: `src/app/app.css`

**Interfaces:**
- Consumes: `TaildropService` -> `getHistory()`, `clearHistory()`
- Produces: Collapsible `.history-section` UI in right workspace panel

- [ ] **Step 1: Add Signals and Methods in Component**

In `src/app/app.ts`, add signals and helper methods:
```typescript
// Import Service classes:
import { TaildropService, Self, Peer, InboxFile, TransferLog } from './taildrop.service';

// Inside App component:
protected readonly transferHistory = signal<TransferLog[]>([]);
protected readonly isHistoryCollapsed = signal<boolean>(false);

protected fetchHistory() {
  this.taildropService.getHistory().subscribe({
    next: (logs) => this.transferHistory.set(logs),
    error: (err) => console.error('Failed to get history logs:', err)
  });
}

protected clearHistory() {
  if (confirm('Are you sure you want to clear your transfer history logs?')) {
    this.taildropService.clearHistory().subscribe({
      next: () => this.transferHistory.set([]),
      error: (err) => alert('Failed to clear history')
    });
  }
}
```
Update `ngOnInit()` to fetch history initially:
```typescript
  ngOnInit() {
    this.fetchStatus();
    this.fetchInbox();
    this.fetchHistory();
    // ... rest of ngOnInit ...
  }
```
Update background polling inside `refreshData()` to fetch history as well:
```typescript
  private refreshData() {
    // ... status update calls ...
    this.fetchInbox();
    this.fetchHistory();
  }
```

- [ ] **Step 2: Add HTML Markup for Collapsible Table**

In `src/app/app.html`, add the history panel directly below the active transfer queue, before `<!-- Select Peer Device State -->` inside the sender-card:
```html
          <!-- History Log Section (Option A: Collapsible Split Panel) -->
          <div class="history-section">
            <div class="history-header" (click)="isHistoryCollapsed.set(!isHistoryCollapsed())">
              <div class="history-title">
                <span>🕒 Transfer History</span>
                <span class="badge pending">{{ transferHistory().length }}</span>
              </div>
              <div class="history-header-actions" (click)="$event.stopPropagation()">
                @if (transferHistory().length > 0) {
                  <button class="btn-queue-action danger" (click)="clearHistory()">Clear History</button>
                }
                <span class="collapse-icon">{{ isHistoryCollapsed() ? '▼' : '▲' }}</span>
              </div>
            </div>

            @if (!isHistoryCollapsed()) {
              <div class="history-list">
                @for (log of transferHistory(); track log.id) {
                  <div class="queue-item-row" [class.success]="log.status === 'success'" [class.error]="log.status === 'failed'">
                    <div class="queue-item-icon">
                      {{ log.direction === 'send' ? '📤' : '📥' }}
                    </div>
                    <div class="queue-item-details">
                      <span class="queue-item-name" [title]="log.filename">{{ log.filename }}</span>
                      <span class="queue-item-meta">
                        {{ formatBytes(log.size) }} • {{ log.peer_name }} via {{ log.protocol }}
                        @if (log.speed_bps && log.status === 'success') {
                          • {{ formatBytes(log.speed_bps) }}/s
                        }
                        @if (log.error_msg) {
                          • <span class="queue-item-msg err" [title]="log.error_msg">{{ log.error_msg }}</span>
                        }
                      </span>
                    </div>
                    <div class="queue-item-status-col">
                      @if (log.status === 'in-progress') {
                        <div class="spinner-small"></div>
                      } @else if (log.status === 'success') {
                        <span class="badge success">Success</span>
                      } @else {
                        <span class="badge error">Failed</span>
                      }
                    </div>
                    
                    <div class="queue-item-action-col">
                      @if (log.direction === 'send' && log.status === 'failed') {
                        <button class="btn-remove-queue" (click)="retryTransfer(log)" title="Retry sending file">
                          ↻
                        </button>
                      }
                    </div>
                  </div>
                }
                @if (transferHistory().length === 0) {
                  <div class="empty-list-view" style="padding: 15px;">
                    <p style="font-size: 11px;">No past transfers recorded.</p>
                  </div>
                }
              </div>
            }
          </div>
```

- [ ] **Step 3: Add CSS Styles for History Section**

In `src/app/app.css`, append styles for the history elements:
```css
.history-section {
  border-top: 1px solid var(--border-color);
  padding-top: 16px;
  margin-top: 16px;
}

.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  padding: 6px 0;
  user-select: none;
}

.history-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-heading);
  font-size: 14px;
  font-weight: 600;
  color: var(--text-header);
}

.history-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.collapse-icon {
  font-size: 10px;
  color: var(--text-dimmed);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 220px;
  overflow-y: auto;
  margin-top: 10px;
  padding-right: 4px;
  animation: slideIn 0.2s ease-out;
}
```

- [ ] **Step 4: Verify Angular Application Compiles & Serves**

Run:
```bash
npm run build
```
Expected: Successful compile without styling or template diagnostics errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/app.ts src/app/app.html src/app/app.css
git commit -m "feat: implement history UI rendering and component signal integration"
```

---

### Task 6: Implement Frontend Retry Flow & Validations

**Files:**
- Modify: `src/app/app.ts`

**Interfaces:**
- Consumes: `selectedPeer` (signal), `peers` (signal), `selectedFiles` (signal), file picker trigger click
- Produces: `retryTransfer(log: TransferLog) -> void` component method

- [ ] **Step 1: Write component retry method with file picker and checks**

In `src/app/app.ts`, add the retry selection and validation method:
```typescript
  // Retry helper method
  protected retryTransfer(log: TransferLog) {
    // 1. Peer online check
    const destPeer = this.peers().find(p => p.id === log.peer_id || p.hostName === log.peer_id || p.hostName === log.peer_name.replace(' (LocalSend)', ''));
    if (!destPeer) {
      alert(`Cannot retry: Target device "${log.peer_name}" is no longer on the network.`);
      return;
    }
    if (!destPeer.online) {
      alert(`Cannot retry: Target device "${destPeer.hostName}" is currently offline.`);
      return;
    }

    // 2. Setup file picker validation
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.onchange = (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (input.files && input.files.length > 0) {
        const selectedFile = input.files[0];
        
        // Validate name and size
        if (selectedFile.name !== log.filename) {
          alert(`File mismatch: Please select "${log.filename}" (you selected "${selectedFile.name}").`);
          return;
        }
        if (selectedFile.size !== log.size) {
          alert(`File size mismatch: Please select the original "${log.filename}" of size ${this.formatBytes(log.size)}.`);
          return;
        }

        // Set matching peer and add real file to queue
        this.selectedPeer.set(destPeer);
        this.addFilesToQueue([selectedFile]);
        
        // Trigger queue transfer
        setTimeout(() => {
          this.triggerQueueTransfer();
        }, 100);
      }
    };

    // Click file picker programmatically
    fileInput.click();
  }
```

- [ ] **Step 2: Verify Angular Application Compiles & Serves**

Run:
```bash
npm run build
```
Expected: Compilation passes.

- [ ] **Step 3: Run Angular UI tests**

Run:
```bash
npm test -- --watch=false
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/app.ts
git commit -m "feat: implement secure client-side file picker retry validation"
```
