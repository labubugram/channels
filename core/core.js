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
        MEDIA_POLL_INTERVAL: 5000,
        MAX_MEDIA_POLL_ATTEMPTS: 12,
        DEDUP_TTL: 5000,
        BUFFER: 8,
        ESTIMATED_HEIGHT: 200,
        VIDEO_HEIGHT: 400,
        LAZY_LOAD_OFFSET: 500,
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
        recentMessages: new Map(),
        theme: localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
        wsMessageQueue: [],
        wsProcessing: false,
        postHeights: new Map(),
        offsets: [],
        totalHeight: 0,
        visiblePosts: new Set(),
        isTransitioning: false,
        pendingTheme: null,
        mediaLoading: new Set(),
        videoPlayers: new Map()
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

    const VideoManager = {
        initVideo(element, messageId, src) {
            if (!element) return;
            
            const video = element.querySelector('video');
            if (!video) return;
            
            video.controls = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.muted = true;
            
            const playVideo = () => {
                if (State.visiblePosts.has(messageId)) {
                    video.play().catch(() => {});
                } else {
                    video.pause();
                }
            };
            
            const pauseVideo = () => {
                video.pause();
            };
            
            State.videoPlayers.set(messageId, {
                element: video,
                play: playVideo,
                pause: pauseVideo
            });
            
            video.addEventListener('loadedmetadata', () => {
                const postEl = element.closest('.post');
                if (postEl) {
                    const currentHeight = postEl.offsetHeight;
                    if (currentHeight > CONFIG.ESTIMATED_HEIGHT) {
                        State.postHeights.set(messageId, currentHeight);
                        VirtualList.rebuildOffsets();
                    }
                }
            });
            
            video.addEventListener('click', (e) => {
                e.stopPropagation();
                if (video.paused) {
                    video.play().catch(() => {});
                } else {
                    video.pause();
                }
            });
        },
        
        updateVisibility() {
            State.videoPlayers.forEach((player, messageId) => {
                if (State.visiblePosts.has(messageId)) {
                    player.play();
                } else {
                    player.pause();
                }
            });
        },
        
        cleanup(messageId) {
            if (State.videoPlayers.has(messageId)) {
                const player = State.videoPlayers.get(messageId);
                if (player.element) {
                    player.element.pause();
                    player.element.src = '';
                    player.element.load();
                }
                State.videoPlayers.delete(messageId);
            }
        }
    };

    const debounce = (fn, delay, options = {}) => {
        let timeoutId;
        let lastCall = 0;
        return function(...args) {
            const now = Date.now();
            if (options.leading && now - lastCall > delay) {
                fn.apply(this, args);
                lastCall = now;
            }
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                if (!options.leading || Date.now() - lastCall > delay) {
                    fn.apply(this, args);
                }
                timeoutId = null;
            }, delay);
        };
    };

    const throttle = (fn, limit) => {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                fn.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
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
            
            if (State.mediaErrorCache.has(messageId)) {
                return null;
            }
            
            if (State.mediaCache.has(messageId)) {
                return State.mediaCache.get(messageId);
            }
            
            if (State.mediaLoading.has(messageId)) {
                return null;
            }
            
            State.mediaLoading.add(messageId);
            
            try {
                const url = `${CONFIG.API_BASE}/api/media/by-message/${messageId}?channel_id=${CONFIG.CHANNEL_ID}`;
                const response = await fetch(url);
                
                if (response.status === 404) {
                    State.mediaErrorCache.add(messageId);
                    return null;
                }
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                
                if (data && data.url) {
                    State.mediaCache.set(messageId, data);
                    return data;
                }
                
                return null;
            } catch (err) {
                return null;
            } finally {
                State.mediaLoading.delete(messageId);
            }
        },
        pollMedia(messageId, callback, maxAttempts = CONFIG.MAX_MEDIA_POLL_ATTEMPTS) {
            if (State.mediaPollingQueue.has(messageId) || State.mediaErrorCache.has(messageId)) {
                return;
            }
            
            const poll = (attempt) => {
                if (attempt > maxAttempts) {
                    State.mediaErrorCache.add(messageId);
                    if (State.mediaPollingQueue.has(messageId)) {
                        const { timeoutId } = State.mediaPollingQueue.get(messageId);
                        if (timeoutId) clearTimeout(timeoutId);
                        State.mediaPollingQueue.delete(messageId);
                    }
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
            if (this.video) {
                this.video.load();
                window.addEventListener('load', () => this.scheduleVideo());
                this.video.play().catch(() => {});
            }
            this.applyTheme(State.theme, false);
        },
        applyTheme(theme, animate = true) {
            if (animate) {
                document.documentElement.classList.add('theme-transitioning');
            }
            document.documentElement.setAttribute('data-theme', theme);
            if (theme === 'dark') {
                this.scheduleVideo();
            } else {
                this.hideVideo();
            }
            if (animate) {
                setTimeout(() => {
                    document.documentElement.classList.remove('theme-transitioning');
                }, 400);
            }
        },
        scheduleVideo() {
            if (!this.video) return;
            if (this.videoTimeoutId) clearTimeout(this.videoTimeoutId);
            this.videoTimeoutId = setTimeout(() => this.showVideo(), 10000);
        },
        showVideo() {
            if (this.video) this.video.classList.add('visible');
        },
        hideVideo() {
            if (this.video) this.video.classList.remove('visible');
            if (this.videoTimeoutId) {
                clearTimeout(this.videoTimeoutId);
                this.videoTimeoutId = null;
            }
        },
        toggle() {
            if (State.isTransitioning) {
                State.pendingTheme = State.theme === 'dark' ? 'light' : 'dark';
                return;
            }
            State.isTransitioning = true;
            if (this.videoTimeoutId) {
                clearTimeout(this.videoTimeoutId);
                this.videoTimeoutId = null;
            }
            const newTheme = State.theme === 'dark' ? 'light' : 'dark';
            requestAnimationFrame(() => {
                State.theme = newTheme;
                localStorage.setItem('theme', newTheme);
                this.applyTheme(newTheme, true);
                State.isTransitioning = false;
                if (State.pendingTheme) {
                    const temp = State.pendingTheme;
                    State.pendingTheme = null;
                    State.theme = temp;
                    this.toggle();
                }
            });
        }
    };

    const VirtualList = {
        feed: null,
        topSpacer: null,
        bottomSpacer: null,
        observer: null,
        isRendering: false,
        pendingRender: false,

        init() {
            this.feed = document.getElementById('feed');
            this.topSpacer = document.createElement('div');
            this.bottomSpacer = document.createElement('div');
            this.topSpacer.className = 'virtual-spacer';
            this.bottomSpacer.className = 'virtual-spacer';
            this.feed.innerHTML = '';
            this.feed.appendChild(this.topSpacer);
            this.feed.appendChild(this.bottomSpacer);
            this.setupIntersectionObserver();
        },

        setupIntersectionObserver() {
            this.observer = new IntersectionObserver((entries) => {
                let needsVideoUpdate = false;
                
                entries.forEach(entry => {
                    const postId = Number(entry.target.dataset.messageId);
                    
                    if (entry.isIntersecting) {
                        State.visiblePosts.add(postId);
                        if (!State.mediaErrorCache.has(postId)) {
                            UI.loadPostMedia(postId);
                        }
                        needsVideoUpdate = true;
                    } else {
                        State.visiblePosts.delete(postId);
                        needsVideoUpdate = true;
                    }
                });
                
                if (needsVideoUpdate) {
                    VideoManager.updateVisibility();
                }
            }, {
                rootMargin: `${CONFIG.LAZY_LOAD_OFFSET}px`,
                threshold: 0.01
            });
        },

        rebuildOffsets() {
            let sum = 0;
            State.offsets = State.postOrder.map(id => {
                const h = State.postHeights.get(id) || CONFIG.ESTIMATED_HEIGHT;
                const current = sum;
                sum += h;
                return current;
            });
            State.totalHeight = sum;
        },

        binarySearchOffset(scrollTop) {
            if (State.offsets.length === 0) return 0;
            let low = 0;
            let high = State.offsets.length - 1;
            while (low <= high) {
                const mid = (low + high) >> 1;
                if (State.offsets[mid] < scrollTop) low = mid + 1;
                else high = mid - 1;
            }
            return Math.max(0, low - 1);
        },

        measureVisibleHeights() {
            this.feed.querySelectorAll('.post').forEach(el => {
                const id = Number(el.dataset.messageId);
                const h = el.offsetHeight;
                if (State.postHeights.get(id) !== h) {
                    State.postHeights.set(id, h);
                }
            });
            this.rebuildOffsets();
        },

        render() {
            if (this.isRendering) {
                this.pendingRender = true;
                return;
            }
            
            this.isRendering = true;
            this.pendingRender = false;

            if (State.postOrder.length === 0) {
                this.isRendering = false;
                return;
            }

            const scrollTop = window.scrollY;
            const viewportHeight = window.innerHeight;

            const startIndex = Math.max(0, this.binarySearchOffset(scrollTop) - CONFIG.BUFFER);
            
            let endIndex = startIndex;
            let visibleHeight = 0;
            while (endIndex < State.postOrder.length && visibleHeight < viewportHeight) {
                const id = State.postOrder[endIndex];
                visibleHeight += State.postHeights.get(id) || CONFIG.ESTIMATED_HEIGHT;
                endIndex++;
            }
            endIndex = Math.min(State.postOrder.length, endIndex + CONFIG.BUFFER);

            const visibleIds = State.postOrder.slice(startIndex, endIndex);
            const topHeight = State.offsets[startIndex] || 0;
            const bottomHeight = State.totalHeight - (State.offsets[endIndex] || State.totalHeight);

            this.topSpacer.style.height = topHeight + 'px';
            this.bottomSpacer.style.height = bottomHeight + 'px';

            const oldPosts = this.feed.querySelectorAll('.post');
            oldPosts.forEach(el => {
                const id = Number(el.dataset.messageId);
                if (this.observer) this.observer.unobserve(el);
                VideoManager.cleanup(id);
                el.remove();
            });

            const fragment = document.createDocumentFragment();
            visibleIds.forEach(id => {
                const post = State.posts.get(id);
                if (post) {
                    const postEl = UI.createPostElement(post);
                    postEl.classList.add('visible');
                    fragment.appendChild(postEl);
                }
            });

            if (fragment.children.length > 0) {
                this.bottomSpacer.before(fragment);
            }

            this.feed.querySelectorAll('.post').forEach(el => {
                if (this.observer) this.observer.observe(el);
            });

            this.measureVisibleHeights();
            
            this.isRendering = false;
            
            if (this.pendingRender) {
                this.render();
            }
        },

        throttledRender: throttle(function() {
            VirtualList.render();
        }, 16)
    };

    const UI = {
        updateChannelInfo() {
            document.getElementById('channelTitle').textContent = CONFIG.CHANNEL_TITLE;
            document.getElementById('channelUsername').textContent = `@${CONFIG.CHANNEL_USERNAME}`;
            const avatarEl = document.getElementById('channelAvatar');
            if (avatarEl) {
                avatarEl.innerHTML = `<img src="nekhebet.svg" style="width:54px; height:54px; object-fit:cover;" alt="Channel avatar" loading="lazy">`;
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
            VirtualList.feed.innerHTML = '';
            VirtualList.feed.appendChild(VirtualList.topSpacer);
            VirtualList.feed.appendChild(VirtualList.bottomSpacer);
            for (let i = 0; i < 3; i++) {
                const skeleton = document.createElement('div');
                skeleton.className = 'skeleton';
                VirtualList.bottomSpacer.before(skeleton);
            }
        },

        isVideoType(url, type) {
            if (type) {
                const typeStr = String(type).toLowerCase();
                if (typeStr.includes('video') || typeStr.includes('animation') || typeStr === 'messagemediadocument') {
                    return true;
                }
            }
            if (url && url.match(/\.(mp4|webm|mov|gif)$/i)) {
                return true;
            }
            return false;
        },

        renderMedia(url, type) {
            if (!url) return '';
            
            const fullUrl = url.startsWith('http') ? url : `${CONFIG.API_BASE}${url}`;
            
            let isVideo = this.isVideoType(url, type);
            
            if (isVideo) {
                return `
                    <div class="media-container video-container" style="min-height: ${CONFIG.VIDEO_HEIGHT}px; background: #000;">
                        <video 
                            src="${fullUrl}" 
                            controls
                            preload="metadata" 
                            playsinline
                            muted
                            style="width: 100%; max-height: ${CONFIG.VIDEO_HEIGHT}px; background: #000;">
                            Ваш браузер не поддерживает видео.
                        </video>
                    </div>
                `;
            } else {
                return `
                    <div class="media-container image-container" style="min-height: 200px; background: var(--bg-secondary);">
                        <img 
                            src="${fullUrl}" 
                            alt="Media" 
                            loading="lazy" 
                            decoding="async"
                            style="width: 100%; max-height: 500px; object-fit: contain;"
                            onload="this.parentElement.style.minHeight = 'auto';"
                            onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'media-error\\'>📷 Ошибка загрузки</div>';">
                    </div>
                `;
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
            let isVideo = false;
            
            if (post.media_url) {
                isVideo = this.isVideoType(post.media_url, post.media_type);
                mediaHTML = this.renderMedia(post.media_url, post.media_type);
            } else if (post.has_media) {
                if (State.mediaCache.has(post.message_id)) {
                    const mediaInfo = State.mediaCache.get(post.message_id);
                    isVideo = this.isVideoType(mediaInfo.url, mediaInfo.file_type || post.media_type);
                    mediaHTML = this.renderMedia(mediaInfo.url, mediaInfo.file_type || post.media_type);
                } else if (State.mediaErrorCache.has(post.message_id)) {
                    mediaHTML = '<div class="media-unavailable">📷 Медиа недоступно</div>';
                } else {
                    mediaHTML = '<div class="media-loading">📷 Загрузка медиа...</div>';
                }
            }
            
            postEl.innerHTML = `
                <div class="post-content">
                    <div class="post-header">
                        <div class="post-avatar">
                            <img src="nekhebet.svg" style="width:36px; height:36px; object-fit:cover;" alt="Channel avatar" loading="lazy">
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
            
            if (isVideo) {
                setTimeout(() => {
                    VideoManager.initVideo(postEl, post.message_id, post.media_url || State.mediaCache.get(post.message_id)?.url);
                }, 0);
            }
            
            const mediaContainer = postEl.querySelector('.media-container');
            if (mediaContainer) {
                mediaContainer.addEventListener('click', () => {
                    const url = post.media_url || State.mediaCache.get(post.message_id)?.url;
                    const type = post.media_type || State.mediaCache.get(post.message_id)?.file_type;
                    if (url) {
                        Lightbox.open(url, type);
                    }
                });
            }
            
            return postEl;
        },

        async loadPostMedia(messageId) {
            const post = State.posts.get(messageId);
            if (!post || !post.has_media) {
                return;
            }
            
            if (post.media_url) {
                return;
            }
            
            if (State.mediaErrorCache.has(messageId)) {
                this.updatePostMediaUnavailable(messageId);
                return;
            }
            
            if (State.mediaLoading.has(messageId)) {
                return;
            }
            
            const mediaInfo = await API.fetchMedia(messageId);
            
            if (mediaInfo && mediaInfo.url) {
                post.media_url = mediaInfo.url;
                post.media_type = mediaInfo.file_type || post.media_type;
                State.posts.set(messageId, post);
                
                const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
                if (postEl) {
                    this.updatePostMedia(messageId, mediaInfo.url, post.media_type);
                }
            }
        },

        updatePostMedia(messageId, url, type) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return;
            
            const mediaContainer = postEl.querySelector('.media-container, .media-loading, .media-unavailable');
            if (mediaContainer) {
                const isVideo = this.isVideoType(url, type);
                const newMedia = this.renderMedia(url, type);
                
                if (newMedia) {
                    mediaContainer.outerHTML = newMedia;
                    
                    if (isVideo) {
                        setTimeout(() => {
                            VideoManager.initVideo(postEl, messageId, url);
                        }, 0);
                    }
                    
                    const newMediaContainer = postEl.querySelector('.media-container');
                    if (newMediaContainer) {
                        newMediaContainer.addEventListener('click', () => {
                            Lightbox.open(url, type);
                        });
                    }
                    
                    postEl.dataset.mediaUrl = url;
                    postEl.dataset.mediaType = type || '';
                    
                    setTimeout(() => {
                        const height = postEl.offsetHeight;
                        State.postHeights.set(messageId, height);
                        VirtualList.rebuildOffsets();
                    }, 100);
                }
            }
        },

        updatePostMediaUnavailable(messageId) {
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (!postEl) return;
            
            const mediaContainer = postEl.querySelector('.media-container, .media-loading');
            if (mediaContainer) {
                mediaContainer.outerHTML = '<div class="media-unavailable">📷 Медиа недоступно</div>';
                
                setTimeout(() => {
                    const height = postEl.offsetHeight;
                    State.postHeights.set(messageId, height);
                    VirtualList.rebuildOffsets();
                }, 100);
            }
        },

        addNewPost(post) {
            State.posts.set(post.message_id, post);
            State.postOrder.unshift(post.message_id);
            
            let estimatedHeight = CONFIG.ESTIMATED_HEIGHT;
            if (post.has_media) {
                if (post.media_type && post.media_type.toLowerCase().includes('video')) {
                    estimatedHeight = CONFIG.VIDEO_HEIGHT;
                }
            }
            State.postHeights.set(post.message_id, estimatedHeight);
            
            VirtualList.rebuildOffsets();
            VirtualList.render();
            
            if (post.has_media && !post.media_url && !State.mediaErrorCache.has(post.message_id)) {
                setTimeout(() => this.loadPostMedia(post.message_id), 200);
            }
        },

        updatePost(messageId, data) {
            const post = State.posts.get(messageId);
            if (!post) return false;
            
            let changed = false;
            
            if (data.text !== undefined) {
                post.text = data.text;
                changed = true;
            }
            
            if (data.media_url) {
                post.media_url = data.media_url;
                State.mediaCache.set(messageId, { url: data.media_url, file_type: data.media_type });
                changed = true;
            }
            
            if (data.media_type) {
                post.media_type = data.media_type;
                changed = true;
            }
            
            if (data.edit_date) {
                post.is_edited = true;
                post.edit_date = data.edit_date;
                changed = true;
            }
            
            State.posts.set(messageId, post);
            
            const postEl = document.querySelector(`.post[data-message-id="${messageId}"]`);
            if (postEl) {
                if (data.text !== undefined) {
                    const textEl = postEl.querySelector('.post-text');
                    if (textEl) textEl.innerHTML = Formatters.formatText(data.text || '');
                }
                
                if (data.edit_date) {
                    const dateEl = postEl.querySelector('.post-date');
                    if (dateEl) {
                        const dateText = Formatters.formatDate(data.edit_date);
                        dateEl.innerHTML = `${dateText} <span class="edited-mark">(ред.)</span>`;
                    }
                }
                
                if (data.media_url) {
                    this.updatePostMedia(messageId, data.media_url, data.media_type);
                }
                
                postEl.classList.add('updated');
                setTimeout(() => postEl.classList.remove('updated'), 2000);
            }
            
            return true;
        },

        deletePost(messageId) {
            State.posts.delete(messageId);
            const index = State.postOrder.indexOf(messageId);
            if (index !== -1) State.postOrder.splice(index, 1);
            State.postHeights.delete(messageId);
            VideoManager.cleanup(messageId);
            VirtualList.rebuildOffsets();
            VirtualList.render();
            API.cancelMediaPoll(messageId);
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
            const isVideo = type && (type.toLowerCase().includes('video') || type === 'animation' || url.match(/\.(mp4|webm|mov)$/i));
            
            content.innerHTML = isVideo
                ? `<video src="${fullUrl}" controls autoplay playsinline style="max-width:100%; max-height:90vh;"></video>`
                : `<img src="${fullUrl}" alt="Media" style="max-width:100%; max-height:90vh; object-fit:contain;">`;
                
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
                State.postHeights.clear();
                State.offset = 0;
                State.hasMore = true;
                VirtualList.feed.innerHTML = '';
                VirtualList.feed.appendChild(VirtualList.topSpacer);
                VirtualList.feed.appendChild(VirtualList.bottomSpacer);
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
                    
                    const newPosts = [];
                    data.messages.forEach(post => {
                        if (!State.posts.has(post.message_id)) {
                            State.posts.set(post.message_id, post);
                            State.postOrder.push(post.message_id);
                            
                            let estimatedHeight = CONFIG.ESTIMATED_HEIGHT;
                            if (post.has_media) {
                                if (post.media_type && post.media_type.toLowerCase().includes('video')) {
                                    estimatedHeight = CONFIG.VIDEO_HEIGHT;
                                }
                            }
                            State.postHeights.set(post.message_id, estimatedHeight);
                            newPosts.push(post);
                        }
                    });
                    
                    VirtualList.rebuildOffsets();
                    VirtualList.render();
                    
                    if (newPosts.length > 0) {
                        setTimeout(() => {
                            newPosts.forEach(post => {
                                if (post.has_media && !post.media_url && !State.mediaErrorCache.has(post.message_id)) {
                                    UI.loadPostMedia(post.message_id);
                                }
                            });
                        }, 300);
                    }
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

    const WebSocketManager = {
        connect() {
            try {
                State.ws = new WebSocket(CONFIG.WS_BASE);
                State.ws.onopen = () => {
                    State.wsConnected = true;
                    State.wsReconnectAttempts = 0;
                    UI.updateConnectionStatus(true);
                    setInterval(() => {
                        if (State.ws && State.ws.readyState === WebSocket.OPEN) {
                            State.ws.send(JSON.stringify({ type: 'ping' }));
                        }
                    }, 30000);
                };
                State.ws.onmessage = (event) => {
                    State.wsMessageQueue.push(event.data);
                    this.processQueue();
                };
                State.ws.onclose = () => {
                    State.wsConnected = false;
                    UI.updateConnectionStatus(false);
                    this.reconnect();
                };
                State.ws.onerror = () => {};
            } catch (err) {
                this.reconnect();
            }
        },
        async processQueue() {
            if (State.wsProcessing) return;
            State.wsProcessing = true;
            while (State.wsMessageQueue.length > 0) {
                const data = JSON.parse(State.wsMessageQueue.shift());
                await this.handleMessage(data);
            }
            State.wsProcessing = false;
        },
        async handleMessage(data) {
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
            
            const hasMedia = !!(data.media_type || data.media_url);
            let mediaType = data.media_type;
            
            const post = {
                message_id: data.message_id,
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
            
            if (window.scrollY < 200) {
                this.flushNewPosts();
            }
        },
        handleEditMessage(data) {
            UI.updatePost(data.message_id, {
                text: data.text,
                edit_date: data.edit_date,
                media_url: data.media_url,
                media_type: data.media_type
            });
        },
        handleDeleteMessage(data) {
            UI.deletePost(data.message_id);
        },
        flushNewPosts() {
            if (State.newPosts.length === 0) return;
            
            while (State.newPosts.length > 0) {
                const post = State.newPosts.shift();
                UI.addNewPost(post);
            }
            
            UI.updateNewPostsBadge();
        }
    };

    const ScrollHandler = {
        init() {
            window.addEventListener('scroll', this.throttledHandle.bind(this), { passive: true });
        },
        handle() {
            UI.showScrollTopButton(window.scrollY > 500);
            
            if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 800) {
                this.debouncedLoadMore();
            }
            
            if (window.scrollY < 200 && State.newPosts.length > 0) {
                WebSocketManager.flushNewPosts();
            }
        },
        throttledHandle: throttle(function() {
            ScrollHandler.handle();
            VirtualList.throttledRender();
        }, 16),
        debouncedLoadMore: debounce(() => {
            if (!State.isLoading && State.hasMore) {
                MessageLoader.loadMessages();
            }
        }, 300, { leading: true, trailing: false })
    };

    function init() {
        VirtualList.init();
        ThemeManager.init();
        UI.updateChannelInfo();
        MessageLoader.loadInitial();
        WebSocketManager.connect();
        ScrollHandler.init();

        document.getElementById('feed').addEventListener('click', (e) => {
            const container = e.target.closest('.media-container');
            if (container) {
                const post = container.closest('.post');
                if (post) {
                    const messageId = Number(post.dataset.messageId);
                    const mediaUrl = post.dataset.mediaUrl || State.mediaCache.get(messageId)?.url;
                    const mediaType = post.dataset.mediaType || State.mediaCache.get(messageId)?.file_type;
                    if (mediaUrl) {
                        Lightbox.open(mediaUrl, mediaType);
                    }
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
