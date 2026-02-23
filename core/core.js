(function() {
    'use strict';

    const CONFIG = {
        API_BASE: document.querySelector('meta[name="mirror:api-base"]')?.content || 'https://0808.us.nekhebet.su:8081',
        CHANNEL_ID: document.querySelector('meta[name="mirror:channel-id"]')?.content,
        CHANNEL_TITLE: document.querySelector('meta[name="mirror:channel-title"]')?.content,
        CHANNEL_USERNAME: document.querySelector('meta[name="mirror:channel-username"]')?.content,
        CHANNEL_AVATAR: document.querySelector('meta[name="mirror:channel-avatar"]')?.content || '📢',
        INITIAL_LIMIT: 20,
        MAX_RECONNECT_ATTEMPTS: 10,
        RECONNECT_BASE_DELAY: 1000,
        MEDIA_RETRY_ATTEMPTS: 3,
        MEDIA_POLL_INTERVAL: 5000,
        MAX_MEDIA_POLL_ATTEMPTS: 12,
        MAX_VISIBLE_POSTS: 100,
        DEDUP_TTL: 5000,
        WS_BASE: (() => {
            const apiBase = document.querySelector('meta[name="mirror:api-base"]')?.content || 'https://0808.us.nekhebet.su:8081';
            return apiBase.replace('http://', 'ws://').replace('https://', 'wss://');
        })()
    };

    const State = {
        posts: new Map(),
        postOrder: [],
        newPosts: [],
        offset: 0,
        hasMore: true,
        isLoading: false,
        ws: null,
        wsConnected: false,
        wsReconnectAttempts: 0,
        mediaCache: new Map(),
        mediaErrorCache: new Set(),
        mediaPollingQueue: new Map(),
        scrollTimeout: null,
        recentMessages: new Map(),
        lastDocumentHeight: 0,
        theme: localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    };

    const Security = {
        escapeHtml(unsafe) {
            return unsafe
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;")
                .replace(/`/g, "&#96;");
        },
        sanitizeUrl(url) {
            try {
                const parsed = new URL(url);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '#';
                if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return '#';
                return url;
            } catch {
                return '#';
            }
        },
        validateMessageId(id) {
            return Number.isInteger(Number(id)) && Number(id) > 0;
        }
    };

    const Formatters = {
        formatDate(date) {
            const d = new Date(date);
            const now = new Date();
            const isToday = d.toDateString() === now.toDateString();
            const yesterday = new Date(now);
            yesterday.setDate(now.getDate() - 1);
            const isYesterday = d.toDateString() === yesterday.toDateString();
            const time = d.toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            if (isToday) return `Сегодня в ${time}`;
            if (isYesterday) return `Вчера в ${time}`;
            return d.toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: 'long',
                year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric'
            }) + ` в ${time}`;
        },
        formatViews(views) {
            if (!views) return '0';
            if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
            if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
            return views.toString();
        },
        formatText(text) {
            if (!text) return '';
            let escaped = Security.escapeHtml(text);
            escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url) => {
                const safeUrl = Security.sanitizeUrl(url);
                if (safeUrl === '#') return match;
                let domain = '';
                try {
                    const urlObj = new URL(url);
                    domain = urlObj.hostname.replace('www.', '');
                } catch {
                    domain = url;
                }
                return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" class="tg-link" title="${url}" data-domain="${domain}">${linkText}</a>`;
            });
            escaped = escaped.replace(/```([\s\S]*?)```/g, '<pre class="tg-code-block"><code>$1</code></pre>');
            escaped = escaped.replace(/`([^`]+)`/g, '<code class="tg-inline-code">$1</code>');
            const formatters = [
                { pattern: /\*\*\*(.*?)\*\*\*/g, replacement: '<b><i>$1</i></b>' },
                { pattern: /\*\*(.*?)\*\*/g, replacement: '<b>$1</b>' },
                { pattern: /__(.*?)__/g, replacement: '<u>$1</u>' },
                { pattern: /\*(.*?)\*/g, replacement: '<i>$1</i>' },
                { pattern: /_(.*?)_/g, replacement: '<i>$1</i>' },
                { pattern: /~~(.*?)~~/g, replacement: '<s>$1</s>' },
                { pattern: /\|\|(.*?)\|\|/g, replacement: '<span class="tg-spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>' }
            ];
            for (const formatter of formatters) {
                escaped = escaped.replace(formatter.pattern, formatter.replacement);
            }
            escaped = escaped.replace(/(?<!href="|">)(https?:\/\/[^\s<"')]+)(?![^<]*>)/g, (url) => {
                const safeUrl = Security.sanitizeUrl(url);
                if (safeUrl === '#') return url;
                let displayDomain = '';
                try {
                    const urlObj = new URL(url);
                    displayDomain = urlObj.hostname.replace('www.', '');
                } catch {
                    displayDomain = url;
                }
                let displayText = url;
                if (url.length > 50) {
                    displayText = url.substring(0, 40) + '…' + url.substring(url.length - 10);
                }
                return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" class="tg-link" data-domain="${displayDomain}" title="${url}">${displayText}</a>`;
            });
            escaped = escaped.replace(/^&gt;&gt;&gt; (.*)$/gm, '<blockquote class="tg-quote level-3">$1</blockquote>');
            escaped = escaped.replace(/^&gt;&gt; (.*)$/gm, '<blockquote class="tg-quote level-2">$1</blockquote>');
            escaped = escaped.replace(/^&gt; (.*)$/gm, '<blockquote class="tg-quote level-1">$1</blockquote>');
            escaped = escaped.replace(/(?<!>|href=")@(\w+)(?!<)/g, '<span class="tg-mention" data-mention="@$1" title="@$1 в Telegram">@$1</span>');
            escaped = escaped.replace(/(?<!>|href=")#(\w+)(?!<)/g, '<span class="tg-hashtag" data-hashtag="#$1">#$1</span>');
            const lines = escaped.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (i < lines.length - 1 && !lines[i].match(/<[^>]+>$/)) {
                    lines[i] += '<br>';
                }
            }
            return lines.join('');
        }
    };

    const API = {
        async fetchMessages(offset = 0, limit = CONFIG.INITIAL_LIMIT) {
            try {
                const response = await fetch(`${CONFIG.API_BASE}/api/channel/posts?channel_id=${CONFIG.CHANNEL_ID}&offset=${offset}&limit=${limit}`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                return {
                    messages: data.posts || [],
                    hasMore: (data.posts || []).length === limit
                };
            } catch (err) {
                return { messages: [], hasMore: false };
            }
        },
        async fetchMedia(messageId) {
            if (!Security.validateMessageId(messageId)) return null;
            if (State.mediaErrorCache.has(messageId)) return null;
            if (State.mediaCache.has(messageId)) return State.mediaCache.get(messageId);
            if (State.mediaPollingQueue.has(messageId)) {
                const { attempts } = State.mediaPollingQueue.get(messageId);
                if (attempts >= CONFIG.MAX_MEDIA_POLL_ATTEMPTS) {
                    State.mediaErrorCache.add(messageId);
                    State.mediaPollingQueue.delete(messageId);
                    return null;
                }
            }
            try {
                const response = await fetch(`${CONFIG.API_BASE}/api/media/by-message/${messageId}?channel_id=${CONFIG.CHANNEL_ID}`);
                if (!response.ok) {
                    if (response.status === 404) return null;
                    throw new Error(`HTTP ${response.status}`);
                }
                const data = await response.json();
                if (data && data.url) {
                    State.mediaCache.set(messageId, data);
                    if (State.mediaPollingQueue.has(messageId)) {
                        const { timeoutId } = State.mediaPollingQueue.get(messageId);
                        if (timeoutId) clearTimeout(timeoutId);
                        State.mediaPollingQueue.delete(messageId);
                    }
                    return data;
                }
            } catch (err) {}
            return null;
        },
        pollMedia(messageId, callback, maxAttempts = CONFIG.MAX_MEDIA_POLL_ATTEMPTS) {
            if (State.mediaPollingQueue.has(messageId) || State.mediaErrorCache.has(messageId)) return;
            const poll = (attempt) => {
                if (attempt > maxAttempts) {
                    if (State.mediaPollingQueue.has(messageId)) {
                        const { timeoutId } = State.mediaPollingQueue.get(messageId);
                        if (timeoutId) clearTimeout(timeoutId);
                        State.mediaPollingQueue.delete(messageId);
                    }
                    State.mediaErrorCache.add(messageId);
                    callback(null, true);
                    return;
                }
                API.fetchMedia(messageId).then(mediaInfo => {
                    if (mediaInfo && mediaInfo.url) {
                        State.mediaCache.set(messageId, mediaInfo);
                        if (State.mediaPollingQueue.has(messageId)) {
                            const { timeoutId } = State.mediaPollingQueue.get(messageId);
                            if (timeoutId) clearTimeout(timeoutId);
                            State.mediaPollingQueue.delete(messageId);
                        }
                        callback(mediaInfo.url, false);
                    } else {
                        if (State.mediaPollingQueue.has(messageId)) {
                            const { timeoutId } = State.mediaPollingQueue.get(messageId);
                            if (timeoutId) clearTimeout(timeoutId);
                        }
                        const timeoutId = setTimeout(() => poll(attempt + 1), CONFIG.MEDIA_POLL_INTERVAL);
                        State.mediaPollingQueue.set(messageId, { attempts: attempt, timeoutId });
                    }
                }).catch(() => {
                    const timeoutId = setTimeout(() => poll(attempt + 1), CONFIG.MEDIA_POLL_INTERVAL);
                    State.mediaPollingQueue.set(messageId, { attempts: attempt, timeoutId });
                });
            };
            poll(1);
        },
        cancelMediaPoll(messageId) {
            if (State.mediaPollingQueue.has(messageId)) {
                const { timeoutId } = State.mediaPollingQueue.get(messageId);
                if (timeoutId) clearTimeout(timeoutId);
                State.mediaPollingQueue.delete(messageId);
            }
        }
    };

    const ThemeManager = {
        video: null,
        videoTimeoutId: null,
        init() {
            this.video = document.getElementById('bgVideo');
            document.documentElement.setAttribute('data-theme', State.theme);
            this.initVideo();
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                if (!localStorage.getItem('theme')) {
                    const theme = e.matches ? 'dark' : 'light';
                    State.theme = theme;
                    document.documentElement.setAttribute('data-theme', theme);
                    this.scheduleVideo();
                }
            });
        },
        initVideo() {
            if (!this.video) return;
            this.video.load();
            window.addEventListener('load', () => this.scheduleVideo());
            this.video.play().catch(() => {});
        },
        scheduleVideo() {
            if (this.videoTimeoutId) clearTimeout(this.videoTimeoutId);
            if (State.theme === 'dark') {
                this.videoTimeoutId = setTimeout(() => this.showVideo(), 10000);
            }
        },
        showVideo() {
            if (this.video) this.video.classList.add('visible');
        },
        hideVideo() {
            if (this.video) this.video.classList.remove('visible');
        },
        toggle() {
            const newTheme = State.theme === 'dark' ? 'light' : 'dark';
            document.documentElement.classList.add('theme-transitioning');
            requestAnimationFrame(() => {
                State.theme = newTheme;
                document.documentElement.setAttribute('data-theme', newTheme);
                localStorage.setItem('theme', newTheme);
                if (newTheme === 'dark') {
                    this.scheduleVideo();
                } else {
                    if (this.videoTimeoutId) {
                        clearTimeout(this.videoTimeoutId);
                        this.videoTimeoutId = null;
                    }
                    this.hideVideo();
                }
                setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 400);
            });
        }
    };

    const UI = {
        trimOldPosts() {
            const posts = document.querySelectorAll('.post');
            if (posts.length > CONFIG.MAX_VISIBLE_POSTS) {
                const toRemove = Array.from(posts).slice(0, posts.length - CONFIG.MAX_VISIBLE_POSTS);
                toRemove.forEach(el => el.remove());
            }
        },
        updateChannelInfo() {
            document.getElementById('channelTitle').textContent = CONFIG.CHANNEL_TITLE;
            document.getElementById('channelUsername').textContent = `@${CONFIG.CHANNEL_USERNAME}`;
            const avatarEl = document.getElementById('channelAvatar');
            if (avatarEl) {
                avatarEl.innerHTML = `<img src="nekhebet.svg" style="width:54px; height:54px; object-fit:cover;" alt="Channel avatar">`;
            }
        },
        updateConnectionStatus(connected) {
            const dot = document.getElementById('statusDot');
            dot.classList.toggle('offline', !connected);
        },
        updateNewPostsBadge() {
            const badge = document.getElementById('newPostsBadge');
            const countSpan = document.getElementById('newPostsCount');
            if (State.newPosts.length > 0) {
                countSpan.textContent = State.newPosts.length;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        },
        showSkeletonLoaders() {
            const feed = document.getElementById('feed');
            feed.innerHTML = '';
            for (let i = 0; i < 3; i++) {
                const skeleton = document.createElement('div');
                skeleton.className = 'skeleton';
                feed.appendChild(skeleton);
            }
        },
        createPostElement(post) {
            const postEl = document.createElement('div');
            postEl.className = 'post';
            postEl.dataset.messageId = post.message_id;
            postEl.dataset.mediaUrl = post.media_url || '';
            postEl.dataset.mediaType = post.media_type || '';
            
            const date = Formatters.formatDate(post.date);
            const views = Formatters.formatViews(post.views);
            const text = Formatters.formatText(post.text);
            
            let mediaHTML = '';
            if (post.media_url) {
                mediaHTML = this.renderMedia(post.media_url, post.media_type);
            } else if (post.has_media) {
                mediaHTML = post.media_unavailable
                    ? '<div class="media-unavailable">📷 Медиа недоступно</div>'
                    : '<div class="media-loading">📷 Загрузка медиа...</div>';
            }
            
            postEl.innerHTML = `
                <div class="post-content">
                    <div class="post-header">
                        <div class="post-avatar">
                            <img src="nekhebet.svg" style="width:36px; height:36px; object-fit:cover;" alt="Channel avatar">
                        </div>
                        <div class="post-author-info">
                            <div class="post-author-name">
                                ${CONFIG.CHANNEL_TITLE}
                                <span class="post-username">@${CONFIG.CHANNEL_USERNAME}</span>
                            </div>
                            <div class="post-date">
                                ${date}
                                ${post.is_edited ? '<span class="edited-mark">(ред.)</span>' : ''}
                            </div>
                        </div>
                    </div>
                    <div class="post-text">${text || '<i></i>'}</div>
                    ${mediaHTML}
                </div>
                <div class="post-footer">
                    <span class="views-count">👁 ${views}</span>
                </div>
            `;
            
            return postEl;
        },
        renderMedia(url, type) {
            if (!url) return '';
            const fullUrl = url.startsWith('http') ? url : `${CONFIG.API_BASE}${url}`;
            let isVideo = false;
            if (type) {
                const typeStr = String(type).toLowerCase();
                isVideo = typeStr.includes('video') || typeStr.includes('document') || 
                         typeStr.includes('animation') || typeStr === 'messagemediadocument' || 
                         typeStr.includes('gif') || typeStr.includes('mp4');
            } else if (fullUrl.match(/\.(mp4|webm|mov|gif)$/i)) {
                isVideo = true;
            }
            if (isVideo) {
                return `
                    <div class="media-container">
                        <video src="${fullUrl}" controls preload="metadata" playsinline>
                            Ваш браузер не поддерживает видео.
                        </video>
                    </div>
                `;
            } else {
                return `
                    <div class="media-container">
                        <img src="${fullUrl}" alt="Media" loading="lazy" decoding="async"
                            onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'media-error\\'>📷 Ошибка загрузки</div>';">
                    </div>
                `;
            }
        },
        renderPosts(posts) {
            const feed = document.getElementById('feed');
            const fragment = document.createDocumentFragment();
            posts.forEach(post => {
                const postEl = this.createPostElement(post);
                fragment.appendChild(postEl);
            });
            feed.appendChild(fragment);
            feed.querySelectorAll('.post').forEach(post => {
                requestAnimationFrame(() => post.classList.add('visible'));
            });
            this.trimOldPosts();
        },
        addPostToTop(post) {
            const feed = document.getElementById('feed');
            const postEl = this.createPostElement(post);
            if (feed.firstChild) {
                feed.insertBefore(postEl, feed.firstChild);
            } else {
                feed.appendChild(postEl);
            }
            requestAnimationFrame(() => {
                postEl.classList.add('visible', 'new');
            });
            setTimeout(() => postEl.classList.remove('new'), 3000);
            this.trimOldPosts();
        },
        updatePost(messageId, data) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            let changed = false;
            if (data.text !== undefined) {
                const textEl = postEl.querySelector('.post-text');
                if (textEl) {
                    textEl.innerHTML = Formatters.formatText(data.text || '');
                    changed = true;
                }
            }
            if (data.edit_date) {
                const dateEl = postEl.querySelector('.post-date');
                if (dateEl) {
                    dateEl.innerHTML = Formatters.formatDate(data.edit_date);
                    if (!dateEl.innerHTML.includes('(ред.)')) {
                        dateEl.innerHTML += ' <span class="edited-mark">(ред.)</span>';
                    }
                    changed = true;
                }
            }
            if (data.media_url) {
                const mediaContainer = postEl.querySelector('.media-container, .media-loading, .media-unavailable');
                if (mediaContainer) {
                    const newMedia = this.renderMedia(data.media_url, data.media_type);
                    if (newMedia) {
                        mediaContainer.outerHTML = newMedia;
                        postEl.dataset.mediaUrl = data.media_url;
                        postEl.dataset.mediaType = data.media_type || '';
                        changed = true;
                    }
                }
            }
            if (changed) {
                postEl.classList.add('updated');
                setTimeout(() => postEl.classList.remove('updated'), 2000);
            }
            return changed;
        },
        updatePostMediaUnavailable(messageId) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            const mediaContainer = postEl.querySelector('.media-loading');
            if (mediaContainer) {
                mediaContainer.outerHTML = '<div class="media-unavailable">📷 Медиа недоступно</div>';
                const post = State.posts.get(Number(messageId));
                if (post) post.media_unavailable = true;
                return true;
            }
            return false;
        },
        deletePost(messageId) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            postEl.classList.add('deleted');
            setTimeout(() => {
                postEl.remove();
                State.posts.delete(messageId);
                const index = State.postOrder.indexOf(Number(messageId));
                if (index !== -1) State.postOrder.splice(index, 1);
                API.cancelMediaPoll(messageId);
            }, 300);
            return true;
        },
        setLoaderVisible(visible) {
            const trigger = document.getElementById('infiniteScrollTrigger');
            if (trigger) {
                trigger.textContent = visible ? 'Загрузка...' : '↓ Загрузить ещё';
            }
        },
        showScrollTopButton(visible) {
            const btn = document.getElementById('scrollTopBtn');
            if (btn) btn.style.display = visible ? 'flex' : 'none';
        }
    };

    const Lightbox = {
        open(url, type) {
            if (!url) return;
            const lightbox = document.getElementById('lightbox');
            const content = document.getElementById('lightboxContent');
            const fullUrl = url.startsWith('http') ? url : `${CONFIG.API_BASE}${url}`;
            const isVideo = type === 'video' || type === 'Video' || url.match(/\.(mp4|webm|mov)$/i);
            content.innerHTML = isVideo
                ? `<video src="${fullUrl}" controls autoplay playsinline></video>`
                : `<img src="${fullUrl}" alt="Media">`;
            lightbox.classList.add('active');
            document.body.style.overflow = 'hidden';
        },
        close() {
            const lightbox = document.getElementById('lightbox');
            lightbox.classList.remove('active');
            document.getElementById('lightboxContent').innerHTML = '';
            document.body.style.overflow = '';
        }
    };

    const MessageLoader = {
        async loadMessages(reset = false) {
            if (State.isLoading) return;
            if (reset) {
                State.posts.clear();
                State.postOrder = [];
                document.getElementById('feed').innerHTML = '';
                State.offset = 0;
                State.hasMore = true;
            }
            if (!State.hasMore) {
                document.getElementById('infiniteScrollTrigger').style.display = 'none';
                return;
            }
            State.isLoading = true;
            UI.setLoaderVisible(true);
            try {
                const data = await API.fetchMessages(State.offset, CONFIG.INITIAL_LIMIT);
                if (data.messages && data.messages.length > 0) {
                    State.hasMore = data.hasMore !== false;
                    State.offset += data.messages.length;
                    data.messages.forEach(post => {
                        if (!State.posts.has(post.message_id)) {
                            State.posts.set(post.message_id, post);
                            State.postOrder.push(post.message_id);
                        }
                    });
                    UI.renderPosts(data.messages);
                    data.messages.forEach(post => {
                        if (post.has_media) {
                            API.fetchMedia(post.message_id).then(mediaInfo => {
                                if (mediaInfo && mediaInfo.url) {
                                    post.media_url = mediaInfo.url;
                                    post.media_type = mediaInfo.file_type || post.media_type;
                                    UI.updatePost(post.message_id, {
                                        media_url: mediaInfo.url,
                                        media_type: post.media_type
                                    });
                                } else {
                                    API.pollMedia(post.message_id, (url, failed) => {
                                        if (url) {
                                            post.media_url = url;
                                            UI.updatePost(post.message_id, { media_url: url });
                                        } else if (failed) {
                                            UI.updatePostMediaUnavailable(post.message_id);
                                        }
                                    });
                                }
                            });
                        }
                    });
                } else {
                    State.hasMore = false;
                }
            } catch (err) {
            } finally {
                State.isLoading = false;
                UI.setLoaderVisible(false);
            }
        },
        async loadInitial() {
            UI.showSkeletonLoaders();
            await this.loadMessages(true);
        }
    };

    const Toast = {
        show(message, type = 'info', duration = 3000) {
            const container = document.getElementById('toastContainer');
            if (!container) return;
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' };
            toast.innerHTML = `${icons[type] || 'ℹ️'} ${message}`;
            container.appendChild(toast);
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translate(-50%, 20px)';
                setTimeout(() => toast.remove(), 300);
            }, duration);
        },
        info(message) { this.show(message, 'info'); },
        success(message) { this.show(message, 'success'); },
        warning(message) { this.show(message, 'warning'); },
        error(message) { this.show(message, 'error'); }
    };

    const WebSocketManager = {
        connect() {
            try {
                State.ws = new WebSocket(CONFIG.WS_BASE);
                State.ws.onopen = () => {
                    State.wsConnected = true;
                    State.wsReconnectAttempts = 0;
                    UI.updateConnectionStatus(true);
                    Toast.success('Подключено к серверу');
                    setInterval(() => {
                        if (State.ws && State.ws.readyState === WebSocket.OPEN) {
                            State.ws.send(JSON.stringify({ type: 'ping' }));
                        }
                    }, 30000);
                };
                State.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (['ping', 'pong', 'welcome', 'heartbeat', 'buffering', 'flush_start', 'flush_complete'].includes(data.type)) return;
                        if (data.channel_id !== parseInt(CONFIG.CHANNEL_ID)) return;
                        const messageKey = `${data.channel_id}-${data.message_id}`;
                        const lastReceived = State.recentMessages.get(messageKey);
                        if (lastReceived && (Date.now() - lastReceived < CONFIG.DEDUP_TTL)) return;
                        State.recentMessages.set(messageKey, Date.now());
                        if (State.recentMessages.size > 100) {
                            const now = Date.now();
                            for (const [key, time] of State.recentMessages.entries()) {
                                if (now - time > CONFIG.DEDUP_TTL) State.recentMessages.delete(key);
                            }
                        }
                        switch (data.type) {
                            case 'new': this.handleNewMessage(data); break;
                            case 'edit': this.handleEditMessage(data); break;
                            case 'delete': this.handleDeleteMessage(data); break;
                        }
                    } catch (err) {}
                };
                State.ws.onclose = () => {
                    State.wsConnected = false;
                    UI.updateConnectionStatus(false);
                    Toast.warning('Отключено от сервера');
                    this.reconnect();
                };
                State.ws.onerror = () => {};
            } catch (err) {
                this.reconnect();
            }
        },
        reconnect() {
            if (State.wsReconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) return;
            State.wsReconnectAttempts++;
            const delay = Math.min(CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, State.wsReconnectAttempts), 30000);
            setTimeout(() => {
                if (!State.wsConnected) this.connect();
            }, delay);
        },
        handleNewMessage(data) {
            if (State.posts.has(data.message_id)) return;
            const hasMedia = !!(data.media_type || data.media_url || data.has_media);
            let mediaType = data.media_type || null;
            if (!mediaType && data.media_url) {
                mediaType = data.media_url.match(/\.(mp4|webm|mov)$/i) ? 'video' : 'photo';
            }
            const post = {
                message_id: data.message_id,
                channel_id: data.channel_id,
                text: data.text || '',
                date: data.date || new Date().toISOString(),
                views: data.views || 0,
                has_media: hasMedia,
                media_type: mediaType,
                media_url: data.media_url,
                is_edited: false
            };
            State.newPosts.push(post);
            UI.updateNewPostsBadge();
            if (window.scrollY < 200) this.flushNewPosts();
            if (hasMedia) {
                if (data.media_url) {
                    post.media_url = data.media_url;
                } else {
                    API.fetchMedia(data.message_id).then(mediaInfo => {
                        if (mediaInfo && mediaInfo.url) {
                            post.media_url = mediaInfo.url;
                            post.media_type = mediaInfo.file_type || post.media_type;
                            const existingPost = document.querySelector(`.post[data-message-id="${data.message_id}"]`);
                            if (existingPost) UI.updatePost(data.message_id, {
                                media_url: mediaInfo.url,
                                media_type: post.media_type
                            });
                        } else {
                            API.pollMedia(data.message_id, (url, failed) => {
                                if (url) {
                                    post.media_url = url;
                                    const existingPost = document.querySelector(`.post[data-message-id="${data.message_id}"]`);
                                    if (existingPost) UI.updatePost(data.message_id, { media_url: url });
                                } else if (failed) {
                                    const existingPost = document.querySelector(`.post[data-message-id="${data.message_id}"]`);
                                    if (existingPost) UI.updatePostMediaUnavailable(data.message_id);
                                }
                            });
                        }
                    });
                }
            }
            Toast.info('Новое сообщение');
        },
        handleEditMessage(data) {
            if (State.posts.has(data.message_id)) {
                const post = State.posts.get(data.message_id);
                if (data.text !== undefined) post.text = data.text;
                if (data.media_url) post.media_url = data.media_url;
                if (data.media_type) post.media_type = data.media_type;
                post.is_edited = true;
                post.edit_date = data.edit_date;
                State.posts.set(data.message_id, post);
            }
            UI.updatePost(data.message_id, {
                text: data.text,
                edit_date: data.edit_date,
                media_url: data.media_url,
                media_type: data.media_type
            });
            Toast.info('Сообщение обновлено');
        },
        handleDeleteMessage(data) {
            State.posts.delete(data.message_id);
            const index = State.postOrder.indexOf(data.message_id);
            if (index !== -1) State.postOrder.splice(index, 1);
            UI.deletePost(data.message_id);
            API.cancelMediaPoll(data.message_id);
            Toast.warning('Сообщение удалено');
        },
        flushNewPosts() {
            if (State.newPosts.length === 0) return;
            while (State.newPosts.length > 0) {
                const post = State.newPosts.shift();
                UI.addPostToTop(post);
                State.posts.set(post.message_id, post);
                State.postOrder.unshift(post.message_id);
            }
            UI.updateNewPostsBadge();
        }
    };

    const ScrollHandler = {
        init() {
            State.lastDocumentHeight = document.documentElement.scrollHeight;
            const resizeObserver = new ResizeObserver(() => {
                State.lastDocumentHeight = document.documentElement.scrollHeight;
            });
            resizeObserver.observe(document.documentElement);
            window.addEventListener('scroll', this.throttledHandle.bind(this), { passive: true });
        },
        handle() {
            UI.showScrollTopButton(window.scrollY > 500);
            if (window.scrollY + window.innerHeight >= State.lastDocumentHeight - 500) {
                if (!State.isLoading && State.hasMore) {
                    MessageLoader.loadMessages();
                }
            }
            if (window.scrollY < 200 && State.newPosts.length > 0) {
                WebSocketManager.flushNewPosts();
            }
        },
        throttledHandle() {
            if (State.scrollTimeout) cancelAnimationFrame(State.scrollTimeout);
            State.scrollTimeout = requestAnimationFrame(() => {
                this.handle();
                State.scrollTimeout = null;
            });
        }
    };

    function init() {
        ThemeManager.init();
        UI.updateChannelInfo();
        MessageLoader.loadInitial();
        WebSocketManager.connect();
        ScrollHandler.init();

        document.getElementById('feed').addEventListener('click', (e) => {
            const container = e.target.closest('.media-container');
            if (container) {
                const post = container.closest('.post');
                if (post && post.dataset.mediaUrl) {
                    Lightbox.open(post.dataset.mediaUrl, post.dataset.mediaType);
                }
            }
        });

        document.getElementById('channelAvatar').addEventListener('click', () => ThemeManager.toggle());
        document.getElementById('newPostsBadge').addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            WebSocketManager.flushNewPosts();
        });
        document.getElementById('scrollTopBtn').addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        document.getElementById('lightboxClose').addEventListener('click', Lightbox.close);
        document.getElementById('lightbox').addEventListener('click', (e) => {
            if (e.target === document.getElementById('lightbox')) Lightbox.close();
        });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && State.newPosts.length > 0) {
                WebSocketManager.flushNewPosts();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
