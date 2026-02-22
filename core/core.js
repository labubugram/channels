
// core.js - Telegram Mirror Core Client
(function() {
    'use strict';

    // Конфигурация из HTML-атрибутов
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
        SCROLL_THROTTLE: 150,
        TOAST_DURATION: 3000,
        MEDIA_POLL_INTERVAL: 5000,
        MAX_MEDIA_POLL_ATTEMPTS: 12,
        WS_BASE: (() => {
            const apiBase = document.querySelector('meta[name="mirror:api-base"]')?.content || 'https://0808.us.nekhebet.su:8081';
            return apiBase.replace('http://', 'ws://').replace('https://', 'wss://');
        })()
    };

    // Состояние приложения
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
        scrollTimeout: null
    };

    // Безопасность
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
                return url;
            } catch {
                return '#';
            }
        },

        validateMessageId(id) {
            return Number.isInteger(Number(id)) && Number(id) > 0;
        },

        validateMediaId(id) {
            return /^[0-9a-f-]+$/.test(id);
        }
    };

    // Форматтеры
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

            escaped = escaped.replace(/```([\s\S]*?)```/g, 
                '<pre style="background: var(--bg-secondary); padding:12px; border-radius:12px; overflow:auto;"><code>$1</code></pre>'
            );

            escaped = escaped.replace(/`([^`]+)`/g,
                '<code style="background: var(--bg-secondary); padding:2px 6px; border-radius:6px; font-family: var(--font-mono);">$1</code>'
            );

            escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
            escaped = escaped.replace(/_(.*?)_/g, '<i>$1</i>');

            escaped = escaped.replace(/^&gt; (.*)$/gm,
                '<blockquote style="border-left:3px solid var(--accent); padding-left:10px; margin:6px 0; color:var(--text-secondary);">$1</blockquote>'
            );

            escaped = escaped.replace(/(https?:\/\/[^\s]+)/g, (url) => {
                const safeUrl = Security.sanitizeUrl(url);
                if (safeUrl === '#') return url;
                return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`;
            });

            escaped = escaped.replace(/@(\w+)/g,
                '<span style="color: var(--accent); cursor:pointer;">@$1</span>'
            );

            escaped = escaped.replace(/#(\w+)/g,
                '<span style="color: var(--accent);">#$1</span>'
            );

            return escaped.replace(/\n/g, '<br>');
        }
    };

    // API клиент
    const API = {
        async fetchMessages(offset = 0, limit = CONFIG.INITIAL_LIMIT) {
            try {
                const response = await fetch(
                    `${CONFIG.API_BASE}/api/channel/posts?channel_id=${CONFIG.CHANNEL_ID}&offset=${offset}&limit=${limit}`
                );

                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const data = await response.json();

                return {
                    messages: data.posts || [],
                    hasMore: (data.posts || []).length === limit
                };

            } catch (err) {
                console.error('Failed to fetch messages:', err);
                return { messages: [], hasMore: false };
            }
        },

        async fetchMedia(messageId) {
            if (!Security.validateMessageId(messageId)) return null;
            
            if (State.mediaErrorCache.has(messageId)) return null;
            if (State.mediaCache.has(messageId)) return State.mediaCache.get(messageId);

            try {
                let url = `${CONFIG.API_BASE}/api/media/by-message/${messageId}?channel_id=${CONFIG.CHANNEL_ID}`;
                
                const response = await fetch(url);
                
                if (!response.ok) {
                    if (response.status === 404) return null;
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                if (data && data.url) {
                    State.mediaCache.set(messageId, data.url);
                    if (State.mediaPollingQueue.has(messageId)) {
                        const { timeoutId } = State.mediaPollingQueue.get(messageId);
                        if (timeoutId) clearTimeout(timeoutId);
                        State.mediaPollingQueue.delete(messageId);
                    }
                    return data.url;
                }
            } catch (err) {
                console.error(`Failed to fetch media for ${messageId}:`, err);
            }
            return null;
        },

        pollMedia(messageId, callback, maxAttempts = CONFIG.MAX_MEDIA_POLL_ATTEMPTS) {
            if (State.mediaPollingQueue.has(messageId)) return;
            if (State.mediaErrorCache.has(messageId)) {
                callback(null, true);
                return;
            }

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

                API.fetchMedia(messageId).then(url => {
                    if (url) {
                        State.mediaCache.set(messageId, url);
                        if (State.mediaPollingQueue.has(messageId)) {
                            const { timeoutId } = State.mediaPollingQueue.get(messageId);
                            if (timeoutId) clearTimeout(timeoutId);
                            State.mediaPollingQueue.delete(messageId);
                        }
                        callback(url, false);
                    } else {
                        if (State.mediaPollingQueue.has(messageId)) {
                            const { timeoutId } = State.mediaPollingQueue.get(messageId);
                            if (timeoutId) clearTimeout(timeoutId);
                        }
                        
                        const timeoutId = setTimeout(() => {
                            poll(attempt + 1);
                        }, CONFIG.MEDIA_POLL_INTERVAL);
                        
                        State.mediaPollingQueue.set(messageId, { 
                            attempts: attempt, 
                            timeoutId
                        });
                    }
                }).catch(() => {
                    if (State.mediaPollingQueue.has(messageId)) {
                        const { timeoutId } = State.mediaPollingQueue.get(messageId);
                        if (timeoutId) clearTimeout(timeoutId);
                    }
                    
                    const timeoutId = setTimeout(() => {
                        poll(attempt + 1);
                    }, CONFIG.MEDIA_POLL_INTERVAL);
                    
                    State.mediaPollingQueue.set(messageId, { 
                        attempts: attempt, 
                        timeoutId
                    });
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

    // UI компоненты
    const UI = {
        updateChannelInfo() {
            document.getElementById('channelTitle').textContent = CONFIG.CHANNEL_TITLE;
            document.getElementById('channelUsername').textContent = `@${CONFIG.CHANNEL_USERNAME}`;
            const avatarEl = document.getElementById('channelAvatar');
            if (avatarEl) {
                avatarEl.textContent = CONFIG.CHANNEL_AVATAR;
            }
        },

        updateConnectionStatus(connected) {
            const dot = document.getElementById('statusDot');
            if (connected) {
                dot.classList.remove('offline');
            } else {
                dot.classList.add('offline');
            }
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

        createPostElement(post) {
            const postEl = document.createElement('div');
            postEl.className = 'post';
            postEl.dataset.messageId = post.message_id;
            
            const date = Formatters.formatDate(post.date);
            const views = Formatters.formatViews(post.views);
            const text = Formatters.formatText(post.text);
            
            let mediaHTML = '';
            if (post.media_url) {
                mediaHTML = this.renderMedia(post.media_url, post.media_type);
            } else if (post.has_media) {
                if (post.media_unavailable) {
                    mediaHTML = '<div class="media-unavailable">📷 Медиа недоступно</div>';
                } else {
                    mediaHTML = '<div class="media-loading">📷 Загрузка медиа...</div>';
                }
            }
            
            postEl.innerHTML = `
                <div class="post-content">
                    <div class="post-header">
                        <div class="post-avatar" style="background: var(--accent); color: white;">
                            ${CONFIG.CHANNEL_AVATAR}
                        </div>
                        <div class="post-author-info">
                            <div class="post-author-name">
                                ${CONFIG.CHANNEL_TITLE}
                                <span style="font-size: 11px; color: var(--text-secondary);">@${CONFIG.CHANNEL_USERNAME}</span>
                            </div>
                            <div class="post-date">
                                ${date}
                                ${post.is_edited ? '<span class="edited-mark">(ред.)</span>' : ''}
                            </div>
                        </div>
                    </div>
                    <div class="post-text">${text || '<i>Пустое сообщение</i>'}</div>
                    ${mediaHTML}
                </div>
                <div class="post-footer">
                    <span class="views-count">👁 ${views}</span>
                </div>
            `;
            
            const mediaContainer = postEl.querySelector('.media-container');
            if (mediaContainer) {
                mediaContainer.addEventListener('click', () => {
                    Lightbox.open(post.media_url, post.media_type);
                });
            }
            
            return postEl;
        },

        renderMedia(url, type) {
            if (!url) return '';
            
            const isVideo = type === 'video' || url.match(/\.(mp4|webm|mov)$/i);
            const fullUrl = url.startsWith('http') ? url : `${CONFIG.API_BASE}${url}`;
            
            if (isVideo) {
                return `
                    <div class="media-container">
                        <video src="${fullUrl}" controls preload="metadata" playsinline>
                            Your browser does not support the video tag.
                        </video>
                    </div>
                `;
            } else {
                return `
                    <div class="media-container">
                        <img 
                            src="${fullUrl}" 
                            alt="Media" 
                            loading="lazy"
                            onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'media-error\\'>📷 Failed to load</div>';"
                        >
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
        },

        addPostToTop(post) {
            const feed = document.getElementById('feed');
            const postEl = this.createPostElement(post);
            postEl.classList.add('new');
            
            if (feed.firstChild) {
                feed.insertBefore(postEl, feed.firstChild);
            } else {
                feed.appendChild(postEl);
            }
            
            requestAnimationFrame(() => {
                postEl.style.opacity = '1';
                postEl.style.transform = 'translateY(0)';
            });
            
            setTimeout(() => {
                postEl.classList.remove('new');
            }, 3000);
        },

        updatePost(messageId, data) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return false;
            
            let changed = false;
            
            if (data.text !== undefined) {
                const textEl = postEl.querySelector('.post-text');
                if (textEl) {
                    textEl.innerHTML = Formatters.formatText(data.text);
                    changed = true;
                }
            }
            
            if (data.edit_date) {
                const dateEl = postEl.querySelector('.post-date');
                if (dateEl) {
                    const dateSpan = dateEl.childNodes[0];
                    if (dateSpan) {
                        dateSpan.textContent = Formatters.formatDate(data.edit_date);
                    }
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
                if (post) {
                    post.media_unavailable = true;
                }
                
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
            if (btn) {
                btn.style.display = visible ? 'flex' : 'none';
            }
        }
    };

    // Lightbox
    const Lightbox = {
        open(url, type) {
            if (!url) return;
            
            const lightbox = document.getElementById('lightbox');
            const content = document.getElementById('lightboxContent');
            const fullUrl = url.startsWith('http') ? url : `${CONFIG.API_BASE}${url}`;
            const isVideo = type === 'video' || url.match(/\.(mp4|webm|mov)$/i);
            
            if (isVideo) {
                content.innerHTML = `<video src="${fullUrl}" controls autoplay></video>`;
            } else {
                content.innerHTML = `<img src="${fullUrl}" alt="Media">`;
            }
            
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

    // Загрузчик сообщений
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
                            API.fetchMedia(post.message_id).then(url => {
                                if (url) {
                                    post.media_url = url;
                                    UI.updatePost(post.message_id, { media_url: url });
                                } else {
                                    API.pollMedia(
                                        post.message_id,
                                        (url, failed) => {
                                            if (url) {
                                                post.media_url = url;
                                                UI.updatePost(post.message_id, { media_url: url });
                                            } else if (failed) {
                                                UI.updatePostMediaUnavailable(post.message_id);
                                            }
                                        }
                                    );
                                }
                            });
                        }
                    });
                } else {
                    State.hasMore = false;
                }
            } catch (err) {
                console.error('Failed to load messages:', err);
                Toast.error('Не удалось загрузить сообщения');
            } finally {
                State.isLoading = false;
                UI.setLoaderVisible(false);
            }
        },

        async loadInitial() {
            await this.loadMessages(true);
        }
    };

    // Toast уведомления
    const Toast = {
        show(message, type = 'info', duration = CONFIG.TOAST_DURATION) {
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

    // WebSocket менеджер
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
                        
                        if (['ping', 'pong', 'welcome', 'heartbeat', 'buffering', 'flush_start', 'flush_complete'].includes(data.type)) {
                            return;
                        }
                        
                        if (data.channel_id !== parseInt(CONFIG.CHANNEL_ID)) {
                            return; // Игнорируем сообщения для других каналов
                        }
                        
                        switch (data.type) {
                            case 'new':
                                this.handleNewMessage(data);
                                break;
                            case 'edit':
                                this.handleEditMessage(data);
                                break;
                            case 'delete':
                                this.handleDeleteMessage(data);
                                break;
                        }
                    } catch (err) {
                        console.error('Failed to parse WebSocket message:', err);
                    }
                };
                
                State.ws.onclose = () => {
                    State.wsConnected = false;
                    UI.updateConnectionStatus(false);
                    Toast.warning('Отключено от сервера');
                    this.reconnect();
                };
                
                State.ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                };
                
            } catch (err) {
                console.error('WebSocket connection error:', err);
                this.reconnect();
            }
        },

        reconnect() {
            if (State.wsReconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
                Toast.error('Не удалось переподключиться');
                return;
            }
            
            State.wsReconnectAttempts++;
            const delay = Math.min(
                CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, State.wsReconnectAttempts),
                30000
            );
            
            setTimeout(() => {
                if (!State.wsConnected) {
                    this.connect();
                }
            }, delay);
        },

        handleNewMessage(data) {
            if (State.posts.has(data.message_id)) return;
            
            const post = {
                message_id: data.message_id,
                channel_id: data.channel_id,
                text: data.text || '',
                date: data.date || new Date().toISOString(),
                views: data.views || 0,
                has_media: !!data.media_type,
                media_type: data.media_type,
                is_edited: false
            };
            
            State.newPosts.push(post);
            UI.updateNewPostsBadge();
            
            if (data.media_type) {
                API.fetchMedia(data.message_id).then(url => {
                    if (url) {
                        post.media_url = url;
                        if (State.posts.has(data.message_id)) {
                            UI.updatePost(data.message_id, { media_url: url, media_type: data.media_type });
                        }
                    } else {
                        API.pollMedia(
                            data.message_id,
                            (url, failed) => {
                                if (url) {
                                    post.media_url = url;
                                    if (State.posts.has(data.message_id)) {
                                        UI.updatePost(data.message_id, { media_url: url });
                                    }
                                } else if (failed) {
                                    UI.updatePostMediaUnavailable(data.message_id);
                                }
                            }
                        );
                    }
                });
            }
            
            Toast.info('Новое сообщение');
        },

        handleEditMessage(data) {
            UI.updatePost(data.message_id, {
                text: data.text,
                edit_date: data.edit_date,
                media_url: data.media_url,
                media_type: data.media_type
            });
            Toast.info('Сообщение обновлено');
        },

        handleDeleteMessage(data) {
            UI.deletePost(data.message_id);
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

    // Обработчик скролла
    const ScrollHandler = {
        init() {
            window.addEventListener('scroll', this.throttledHandle.bind(this));
        },

        handle() {
            UI.showScrollTopButton(window.scrollY > 500);
            
            const scrollY = window.scrollY;
            const windowHeight = window.innerHeight;
            const documentHeight = document.documentElement.scrollHeight;
            
            if (scrollY + windowHeight >= documentHeight - 500) {
                if (!State.isLoading && State.hasMore) {
                    MessageLoader.loadMessages();
                }
            }
            
            if (window.scrollY < 200 && State.newPosts.length > 0) {
                WebSocketManager.flushNewPosts();
            }
        },

        throttledHandle() {
            if (State.scrollTimeout) {
                clearTimeout(State.scrollTimeout);
            }
            
            State.scrollTimeout = setTimeout(() => {
                this.handle();
                State.scrollTimeout = null;
            }, CONFIG.SCROLL_THROTTLE);
        }
    };

    // Инициализация
    function init() {
        UI.updateChannelInfo();
        MessageLoader.loadInitial();
        WebSocketManager.connect();
        ScrollHandler.init();
        
        document.getElementById('newPostsBadge').addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            WebSocketManager.flushNewPosts();
        });
        
        document.getElementById('scrollTopBtn').addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        
        document.getElementById('lightboxClose').addEventListener('click', Lightbox.close);
        document.getElementById('lightbox').addEventListener('click', (e) => {
            if (e.target === document.getElementById('lightbox')) {
                Lightbox.close();
            }
        });
        
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && State.newPosts.length > 0) {
                WebSocketManager.flushNewPosts();
            }
        });
    }

    // Запуск
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
