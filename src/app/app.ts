import { Component, signal, computed, inject, OnInit, OnDestroy } from '@angular/core';
import { TaildropService, Self, Peer, InboxFile } from './taildrop.service';
import JSZip from 'jszip';

export interface QueueItem {
  id: string;
  file: File;
  status: 'pending' | 'sending' | 'success' | 'error';
  message: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  standalone: true,
  imports: []
})
export class App implements OnInit, OnDestroy {
  private readonly taildropService = inject(TaildropService);

  // Core signals for application state
  protected readonly selfDevice = signal<Self | null>(null);
  protected readonly peers = signal<Peer[]>([]);
  protected readonly inboxFiles = signal<InboxFile[]>([]);
  protected readonly searchQuery = signal<string>('');
  protected readonly selectedPeer = signal<Peer | null>(null);
  protected readonly selectedFiles = signal<QueueItem[]>([]);
  
  // UI states
  protected readonly isTransferring = signal<boolean>(false);
  protected readonly loadingStatus = signal<boolean>(true);
  protected readonly loadingInbox = signal<boolean>(true);
  protected readonly isDragging = signal<boolean>(false);
  protected readonly notificationsEnabled = signal<boolean>(false);

  private refreshIntervalId: any = null;
  private knownFileNames = new Set<string>();
  private isInitialInboxLoad = true;

  // Computed signal to filter peers based on search query
  protected readonly filteredPeers = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    const allPeers = this.peers();
    
    if (!query) {
      // Sort online peers first, then alphabetically
      return [...allPeers].sort((a, b) => {
        if (a.online === b.online) {
          return a.hostName.localeCompare(b.hostName);
        }
        return a.online ? -1 : 1;
      });
    }

    return allPeers
      .filter(peer => 
        peer.hostName.toLowerCase().includes(query) || 
        (peer.ip && peer.ip.includes(query)) ||
        peer.os.toLowerCase().includes(query)
      )
      .sort((a, b) => {
        if (a.online === b.online) {
          return a.hostName.localeCompare(b.hostName);
        }
        return a.online ? -1 : 1;
      });
  });

  ngOnInit() {
    this.fetchStatus();
    this.fetchInbox();

    // Check notification permission
    if ('Notification' in window) {
      const isGranted = Notification.permission === 'granted';
      const isDisabled = localStorage.getItem('notifications_disabled') === 'true';
      this.notificationsEnabled.set(isGranted && !isDisabled);
    }

    // Start background sync every 5 seconds
    this.refreshIntervalId = setInterval(() => {
      this.refreshData();
    }, 5000);
  }

  ngOnDestroy() {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }
  }

  // Request browser notification permission or toggle local state
  protected requestNotificationPermission() {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        const nextState = !this.notificationsEnabled();
        this.notificationsEnabled.set(nextState);
        localStorage.setItem('notifications_disabled', String(!nextState));
      } else {
        Notification.requestPermission().then(permission => {
          const isGranted = permission === 'granted';
          this.notificationsEnabled.set(isGranted);
          localStorage.setItem('notifications_disabled', String(!isGranted));
        });
      }
    } else {
      alert('Desktop notifications are not supported by this browser.');
    }
  }

  // Synthesize notification chime using Web Audio API
  private playChime() {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      
      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'sine';
      // Play E5 (659.25 Hz) then A5 (880.00 Hz)
      osc.frequency.setValueAtTime(659.25, ctx.currentTime);
      osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.12);
      
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (err) {
      console.warn('Web Audio synthesis failed:', err);
    }
  }

  // Fetch status of self and peers
  protected fetchStatus() {
    this.taildropService.getStatus().subscribe({
      next: (data) => {
        this.selfDevice.set(data.self);
        
        // Update peer list while keeping the selected peer reference updated
        const oldSelected = this.selectedPeer();
        this.peers.set(data.peers);
        
        if (oldSelected) {
          const updatedPeer = data.peers.find(p => p.id === oldSelected.id);
          if (updatedPeer) {
            this.selectedPeer.set(updatedPeer);
          }
        }
        this.loadingStatus.set(false);
      },
      error: (err) => {
        console.error('Failed to get status:', err);
        this.loadingStatus.set(false);
      }
    });
  }

  // Fetch received files in the inbox with delta notification checking
  protected fetchInbox() {
    this.taildropService.getInbox().subscribe({
      next: (files) => {
        const newFileNames = new Set(files.map(f => f.filename));

        if (!this.isInitialInboxLoad) {
          let foundNew = false;
          for (const file of files) {
            if (!this.knownFileNames.has(file.filename)) {
              foundNew = true;
              
              // Push notification if permitted
              if (this.notificationsEnabled()) {
                new Notification('File Received', {
                  body: `Received "${file.filename}" (${this.formatBytes(file.size)})`,
                });
              }
            }
          }
          if (foundNew) {
            this.playChime();
          }
        } else {
          this.isInitialInboxLoad = false;
        }

        this.knownFileNames = newFileNames;
        this.inboxFiles.set(files);
        this.loadingInbox.set(false);
      },
      error: (err) => {
        console.error('Failed to get inbox:', err);
        this.loadingInbox.set(false);
      }
    });
  }

  // Silent background refresh
  private refreshData() {
    this.taildropService.getStatus().subscribe({
      next: (data) => {
        this.selfDevice.set(data.self);
        // Preserve latency & pinging UI states when background status refreshes
        const currentPeers = this.peers();
        const updatedPeers = data.peers.map(np => {
          const matchingOld = currentPeers.find(op => op.id === np.id);
          if (matchingOld) {
            return {
              ...np,
              latency: matchingOld.latency,
              pinging: matchingOld.pinging,
              curAddr: matchingOld.latency ? matchingOld.curAddr : np.curAddr,
              relay: matchingOld.latency ? matchingOld.relay : np.relay
            };
          }
          return np;
        });

        this.peers.set(updatedPeers);
        const oldSelected = this.selectedPeer();
        if (oldSelected) {
          const updatedPeer = updatedPeers.find(p => p.id === oldSelected.id);
          if (updatedPeer) {
            this.selectedPeer.set(updatedPeer);
          }
        }
      }
    });

    this.fetchInbox();
  }

  // User-initiated sync
  protected syncInbox() {
    this.loadingInbox.set(true);
    this.fetchInbox();
  }

  // Handle peer selection
  protected selectPeer(peer: Peer) {
    this.selectedPeer.set(peer);
  }

  // Update search query signal
  protected onSearchInput(event: Event) {
    const input = event.target as HTMLInputElement;
    this.searchQuery.set(input.value);
  }

  // Trigger peer ping latency checker
  protected pingDevice(peer: Peer, event: Event) {
    event.stopPropagation(); // Avoid triggering device selection on card click
    if (peer.pinging) return;

    this.peers.update(list => 
      list.map(p => p.id === peer.id ? { ...p, pinging: true } : p)
    );

    this.taildropService.pingPeer(peer.hostName).subscribe({
      next: (res) => {
        this.peers.update(list => 
          list.map(p => p.id === peer.id ? { 
            ...p, 
            pinging: false, 
            latency: res.latencyMs,
            curAddr: res.direct ? 'Direct' : null,
            relay: res.direct ? null : 'Relayed'
          } : p)
        );
      },
      error: (err) => {
        console.error(`Ping failed for ${peer.hostName}:`, err);
        this.peers.update(list => 
          list.map(p => p.id === peer.id ? { ...p, pinging: false, latency: -1 } : p)
        );
      }
    });
  }

  // Handle file selection via file browser
  protected onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const files = Array.from(input.files);
      this.addFilesToQueue(files);
      input.value = '';
    }
  }

  // Drag & Drop handlers
  protected onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(true);
  }

  protected onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
  }

  protected onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);

    if (event.dataTransfer) {
      this.handleDropFilesAndDirectories(event.dataTransfer);
    }
  }

  // Recursive HTML5 Directory Tree walker and compressor
  private async handleDropFilesAndDirectories(dataTransfer: DataTransfer) {
    const items = dataTransfer.items;
    if (!items) {
      const files = Array.from(dataTransfer.files);
      this.addFilesToQueue(files);
      return;
    }

    const promises: Promise<void>[] = [];
    const filesToQueue: File[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          if (entry.isFile) {
            promises.push(new Promise((resolve) => {
              (entry as FileSystemFileEntry).file((file) => {
                filesToQueue.push(file);
                resolve();
              }, () => resolve());
            }));
          } else if (entry.isDirectory) {
            promises.push(this.zipDirectoryEntry(entry as FileSystemDirectoryEntry));
          }
        } else {
          const file = item.getAsFile();
          if (file) filesToQueue.push(file);
        }
      }
    }

    await Promise.all(promises);
    if (filesToQueue.length > 0) {
      this.addFilesToQueue(filesToQueue);
    }
  }

  private addFilesToQueue(files: File[]) {
    const newItems: QueueItem[] = files.map(file => ({
      id: Math.random().toString(36).substring(2, 9),
      file,
      status: 'pending',
      message: ''
    }));
    this.selectedFiles.update(filesList => [...filesList, ...newItems]);
  }

  private async zipDirectoryEntry(dirEntry: FileSystemDirectoryEntry): Promise<void> {
    const zip = new JSZip();
    
    // Add placeholder to queue indicating compression progress
    const queueId = Math.random().toString(36).substring(2, 9);
    this.selectedFiles.update(q => [...q, {
      id: queueId,
      file: new File([], `${dirEntry.name}.zip`),
      status: 'sending',
      message: 'Zipping folder...'
    }]);

    try {
      await this.traverseDirectory(dirEntry, '', zip);
      const content = await zip.generateAsync({ type: 'blob' });
      const zippedFile = new File([content], `${dirEntry.name}.zip`, { type: 'application/zip' });
      
      // Update placeholder in queue
      this.selectedFiles.update(items => 
        items.map(item => item.id === queueId ? {
          ...item,
          file: zippedFile,
          status: 'pending',
          message: 'Compressed folder'
        } : item)
      );
    } catch (err) {
      console.error('Failed to zip folder:', err);
      this.selectedFiles.update(items => 
        items.map(item => item.id === queueId ? {
          ...item,
          status: 'error',
          message: 'Compression failed'
        } : item)
      );
    }
  }

  private traverseDirectory(dirEntry: FileSystemDirectoryEntry, path: string, zip: JSZip): Promise<void> {
    return new Promise((resolve, reject) => {
      const reader = dirEntry.createReader();
      
      const readEntries = () => {
        reader.readEntries(async (entries) => {
          if (entries.length === 0) {
            resolve();
            return;
          }
          
          try {
            for (const entry of entries) {
              const relativePath = path ? `${path}/${entry.name}` : entry.name;
              if (entry.isFile) {
                await new Promise<void>((resFile, rejFile) => {
                  (entry as FileSystemFileEntry).file((file) => {
                    zip.file(relativePath, file);
                    resFile();
                  }, (err) => rejFile(err));
                });
              } else if (entry.isDirectory) {
                await this.traverseDirectory(entry as FileSystemDirectoryEntry, relativePath, zip);
              }
            }
            readEntries();
          } catch (err) {
            reject(err);
          }
        }, (err) => reject(err));
      };
      
      readEntries();
    });
  }

  protected removeItemFromQueue(id: string) {
    if (this.isTransferring()) return;
    this.selectedFiles.update(items => items.filter(item => item.id !== id));
  }

  protected clearQueue() {
    if (this.isTransferring()) return;
    this.selectedFiles.set([]);
  }

  protected clearCompleted() {
    if (this.isTransferring()) return;
    this.selectedFiles.update(items => items.filter(item => item.status !== 'success'));
  }

  // Send all pending files in the queue sequentially via Taildrop
  protected triggerQueueTransfer() {
    const peer = this.selectedPeer();
    if (!peer || this.isTransferring()) return;

    const pendingItems = this.selectedFiles().filter(item => item.status === 'pending' || item.status === 'error');
    if (pendingItems.length === 0) return;

    this.isTransferring.set(true);
    this.processNextInQueue(peer.hostName, 0, pendingItems);
  }

  private processNextInQueue(targetHostName: string, index: number, items: QueueItem[]) {
    if (index >= items.length) {
      this.isTransferring.set(false);
      this.fetchInbox(); // Harvest any sent files if we sent them locally
      return;
    }

    const item = items[index];
    this.updateItemStatus(item.id, 'sending', 'Sending...');

    this.taildropService.sendFile(targetHostName, item.file).subscribe({
      next: (res) => {
        this.updateItemStatus(item.id, 'success', 'Sent');
        this.processNextInQueue(targetHostName, index + 1, items);
      },
      error: (err) => {
        console.error(`Failed to transfer ${item.file.name}:`, err);
        const errMsg = err.error?.details || err.error?.error || 'Failed to send';
        this.updateItemStatus(item.id, 'error', errMsg);
        this.processNextInQueue(targetHostName, index + 1, items);
      }
    });
  }

  private updateItemStatus(id: string, status: QueueItem['status'], message: string) {
    this.selectedFiles.update(items => 
      items.map(item => item.id === id ? { ...item, status, message } : item)
    );
  }

  // Download a received file
  protected downloadFile(file: InboxFile) {
    const downloadUrl = `/api/download/${encodeURIComponent(file.filename)}`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Delete a received file
  protected deleteFile(file: InboxFile) {
    if (confirm(`Are you sure you want to delete ${file.filename} from this server's inbox?`)) {
      this.taildropService.deleteFile(file.filename).subscribe({
        next: () => {
          this.inboxFiles.update(files => files.filter(f => f.filename !== file.filename));
        },
        error: (err) => {
          console.error('Failed to delete file:', err);
          alert('Failed to delete file. Please try again.');
        }
      });
    }
  }

  // Server-side archive unzipping handler
  protected extractArchive(file: InboxFile) {
    if (confirm(`Extract folder contents from archive "${file.filename}"?`)) {
      this.loadingInbox.set(true);
      this.taildropService.extractZip(file.filename).subscribe({
        next: (res) => {
          alert(res.message);
          this.fetchInbox();
        },
        error: (err) => {
          console.error('Failed to extract file:', err);
          alert(err.error?.details || err.error?.error || 'Failed to extract archive.');
          this.loadingInbox.set(false);
        }
      });
    }
  }

  // Helper: Format file size
  protected formatBytes(bytes: number, decimals = 2): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  // Helper: Format received date
  protected formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  // Helper: Detect if peer is a LocalSend device
  protected isLocalSend(peer: Peer | null): boolean {
    if (!peer) return false;
    return peer.id.startsWith('localsend-') || peer.relay === 'LocalSend Protocol';
  }

  // Helper: Get OS Icon class/color
  protected getOsColor(osName: string): string {
    const name = osName.toLowerCase();
    if (name.includes('mac') || name.includes('ios') || name.includes('apple') || name.includes('tvos')) {
      return 'var(--os-apple)';
    }
    if (name.includes('windows')) {
      return 'var(--os-windows)';
    }
    if (name.includes('android')) {
      return 'var(--os-android)';
    }
    if (name.includes('linux')) {
      return 'var(--os-linux)';
    }
    return 'var(--text-muted)';
  }

  // Helper: Get File icon color and type based on extension
  protected getFileTypeDetails(filename: string): { type: string, icon: string } {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    
    const images = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico'];
    const videos = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv'];
    const audio = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];
    const documents = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'json'];
    const archives = ['zip', 'rar', 'tar', 'gz', '7z'];

    if (images.includes(ext)) return { type: 'image', icon: '🎨' };
    if (videos.includes(ext)) return { type: 'video', icon: '🎬' };
    if (audio.includes(ext)) return { type: 'audio', icon: '🎵' };
    if (documents.includes(ext)) return { type: 'document', icon: '📄' };
    if (archives.includes(ext)) return { type: 'archive', icon: '📦' };
    return { type: 'generic', icon: '📁' };
  }
}
