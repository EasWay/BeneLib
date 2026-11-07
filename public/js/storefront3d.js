const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const segment = (value, start, end) => clamp((value - start) / (end - start));
const ease = value => value < 0.5 ? 4 * value ** 3 : 1 - ((-2 * value + 2) ** 3) / 2;
const lerp = (from, to, amount) => from + (to - from) * amount;
const damp = (from, to, speed, delta) => lerp(from, to, 1 - Math.exp(-speed * delta));

const BOOK_WIDTH = 1.4;
const BOOK_HEIGHT = 2;
const COVER_THICKNESS = 0.034;
const PAGE_THICKNESS = 0.2;
const PAGE_LENGTH = BOOK_WIDTH - 0.05;
const TEXTURE_WIDTH = 1024;
const TEXTURE_HEIGHT = 1464;
let woodCanvas;

function bookData(book) {
    return {
        ...book,
        t: String(book.t || book.title || 'A Good Book'),
        a: String(book.a || book.author || 'Quiet Chapters Editions'),
        y: book.y ?? book.year ?? 2026,
        bg: book.bg || '#1f3b2d',
        fg: book.fg || '#f4efe8',
    };
}

function canvas(width, height) {
    const node = document.createElement('canvas');
    node.width = width;
    node.height = height;
    return node;
}

function luminance(hex) {
    const values = hex.replace('#', '').match(/.{2}/g).map(value => parseInt(value, 16) / 255);
    return values.reduce((sum, channel, index) => {
        const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][index];
    }, 0);
}

function wrapLines(context, text, maxWidth) {
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (context.measureText(next).width > maxWidth && line) {
            lines.push(line);
            line = word;
        } else {
            line = next;
        }
    }
    if (line) lines.push(line);
    return lines;
}

function spaced(context, text, x, y, spacing) {
    for (const letter of text) {
        context.fillText(letter, x, y);
        x += context.measureText(letter).width + spacing;
    }
}

function grain(context, width, height, count, alpha) {
    for (let i = 0; i < count; i++) {
        context.fillStyle = Math.random() < 0.5
            ? `rgba(255,255,255,${alpha})`
            : `rgba(0,0,0,${alpha})`;
        context.fillRect(Math.random() * width, Math.random() * height, 1 + Math.random() * 3, 1);
    }
}

function paintCover(book, rough = false) {
    const target = canvas(TEXTURE_WIDTH, TEXTURE_HEIGHT);
    const context = target.getContext('2d');
    const dark = luminance(book.bg) < 0.32;
    context.fillStyle = rough ? '#d4d4d4' : book.bg;
    context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
    if (!rough) {
        grain(context, TEXTURE_WIDTH, TEXTURE_HEIGHT, 26000, 0.035);
        for (let y = 0; y < TEXTURE_HEIGHT; y += 3) {
            context.fillStyle = `rgba(0,0,0,${Math.random() * 0.025})`;
            context.fillRect(0, y, TEXTURE_WIDTH, 1);
        }
        const vignette = context.createRadialGradient(
            TEXTURE_WIDTH * 0.55, TEXTURE_HEIGHT * 0.45, TEXTURE_WIDTH * 0.2,
            TEXTURE_WIDTH * 0.5, TEXTURE_HEIGHT * 0.5, TEXTURE_WIDTH * 0.95,
        );
        vignette.addColorStop(0, 'rgba(255,255,255,0.05)');
        vignette.addColorStop(1, 'rgba(0,0,0,0.22)');
        context.fillStyle = vignette;
        context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
        context.fillStyle = 'rgba(0,0,0,.18)';
        context.fillRect(0, 0, 26, TEXTURE_HEIGHT);
    }

    const plain = rough ? '#3a3a3a' : dark ? 'rgba(239,233,220,.82)' : book.fg;
    const foil = (from, to) => {
        if (rough) return '#3a3a3a';
        if (!dark) return book.fg;
        const gradient = context.createLinearGradient(0, from, 0, to);
        gradient.addColorStop(0, '#F3DCA8');
        gradient.addColorStop(0.45, '#C9A15E');
        gradient.addColorStop(0.55, '#E9CF94');
        gradient.addColorStop(1, '#A9813F');
        return gradient;
    };
    context.strokeStyle = rough ? '#555' : dark ? 'rgba(220,190,130,.55)' : book.fg;
    context.globalAlpha = rough || dark ? 1 : 0.35;
    context.lineWidth = 3;
    context.strokeRect(70, 70, TEXTURE_WIDTH - 140, TEXTURE_HEIGHT - 140);
    context.strokeRect(84, 84, TEXTURE_WIDTH - 168, TEXTURE_HEIGHT - 168);
    context.globalAlpha = 1;
    context.fillStyle = plain;
    context.font = '500 30px "Geist Mono", monospace';
    spaced(context, book.a.toUpperCase(), 140, 210, 7);
    const largeTitle = book.t.length > 26;
    const titleSize = largeTitle ? 104 : 128;
    const lineHeight = largeTitle ? 108 : 130;
    context.font = `500 ${titleSize}px Newsreader, Georgia, serif`;
    const lines = wrapLines(context, book.t, TEXTURE_WIDTH - 280);
    const titleY = TEXTURE_HEIGHT - 330 - (lines.length - 1) * lineHeight;
    context.fillStyle = foil(titleY - 110, titleY + lines.length * lineHeight);
    lines.forEach((line, index) => context.fillText(line, 136, titleY + index * lineHeight));
    context.fillRect(140, TEXTURE_HEIGHT - 268, 150, 3);
    context.fillStyle = rough ? '#3a3a3a' : dark ? 'rgba(239,233,220,.7)' : book.fg;
    context.font = '500 24px "Geist Mono", monospace';
    spaced(context, 'QUIET CHAPTERS EDITION', 140, TEXTURE_HEIGHT - 190, 8);
    context.strokeStyle = context.fillStyle;
    context.lineWidth = 2.5;
    context.beginPath();
    context.arc(TEXTURE_WIDTH - 190, TEXTURE_HEIGHT - 200, 34, 0, Math.PI * 2);
    context.stroke();
    context.font = 'italic 400 34px Newsreader, Georgia, serif';
    context.textAlign = 'center';
    context.fillText('QC', TEXTURE_WIDTH - 190, TEXTURE_HEIGHT - 189);
    context.textAlign = 'left';
    return target;
}

function paintPaper(context, width, height, spineRight) {
    context.fillStyle = '#F2ECDF';
    context.fillRect(0, 0, width, height);
    grain(context, width, height, 18000, 0.02);
    const shade = spineRight
        ? context.createLinearGradient(width, 0, width - 170, 0)
        : context.createLinearGradient(0, 0, 170, 0);
    shade.addColorStop(0, 'rgba(90,65,35,.22)');
    shade.addColorStop(1, 'rgba(90,65,35,0)');
    context.fillStyle = shade;
    context.fillRect(0, 0, width, height);
}

function paintTextLines(context, x, y, width, rows, seed) {
    let random = seed || 1;
    const next = () => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280;
    };
    context.fillStyle = 'rgba(48,36,24,.58)';
    for (let row = 0; row < rows; row++) {
        let left = x + (row % 9 === 0 ? 48 : 0);
        const right = x + width - (row % 9 === 8 ? width * (0.3 + next() * 0.4) : 0);
        while (left < right - 20) {
            const lineWidth = Math.min(22 + next() * 70, right - left);
            context.fillRect(left, y + row * 38, lineWidth, 11);
            left += lineWidth + 11;
        }
    }
}

function paintPage(kind, book) {
    const target = canvas(TEXTURE_WIDTH, TEXTURE_HEIGHT);
    const back = kind.endsWith('-back');
    const source = back ? canvas(TEXTURE_WIDTH, TEXTURE_HEIGHT) : target;
    const context = source.getContext('2d');
    paintPaper(context, TEXTURE_WIDTH, TEXTURE_HEIGHT, back);
    const left = back ? 110 : 150;
    const width = TEXTURE_WIDTH - 260;
    const middle = TEXTURE_WIDTH / 2 + (back ? -20 : 20);
    context.textAlign = 'center';
    if (kind === 'title') {
        context.font = '500 28px "Geist Mono", monospace';
        context.fillStyle = '#6B5A44';
        context.fillText(book.a.toUpperCase(), middle, 470);
        context.fillStyle = '#2B2118';
        context.font = '500 92px Newsreader, Georgia, serif';
        const lines = wrapLines(context, book.t, TEXTURE_WIDTH - 300);
        lines.forEach((line, index) => context.fillText(line, middle, 640 + index * 100));
        context.fillStyle = '#B08A50';
        context.fillRect(middle - 60, 700 + lines.length * 100, 120, 3);
        context.fillStyle = '#6B5A44';
        context.font = 'italic 400 34px Newsreader, Georgia, serif';
        context.fillText('The Quiet Chapters Edition', middle, 800 + lines.length * 100);
        context.font = '500 22px "Geist Mono", monospace';
        context.fillText('ACCRA · 2026', middle, TEXTURE_HEIGHT - 170);
    } else if (kind === 'edition-back') {
        context.textAlign = 'left';
        context.fillStyle = '#6B5A44';
        context.font = '400 27px Newsreader, Georgia, serif';
        [
            book.t, `by ${book.a}`, '', `First published ${book.y}.`,
            '',
            'This edition typeset by Quiet Chapters,', 'Accra, Ghana, 2026.',
        ].forEach((line, index) => context.fillText(line, left, TEXTURE_HEIGHT - 560 + index * 40));
    } else if (kind === 'chapter') {
        context.fillStyle = '#6B5A44';
        context.font = '500 24px "Geist Mono", monospace';
        context.fillText('CHAPTER ONE', middle, 330);
        context.fillStyle = '#2B2118';
        context.font = '400 120px Newsreader, Georgia, serif';
        context.fillText('I', middle, 470);
        context.fillStyle = '#B08A50';
        context.fillRect(middle - 40, 520, 80, 3);
        context.textAlign = 'left';
        context.fillStyle = '#2B2118';
        context.font = '500 150px Newsreader, Georgia, serif';
        context.fillText(book.t.startsWith('The ') ? book.t[4] : book.t[0], left, 738);
        paintTextLines(context, left + 125, 625, width - 125, 3, book.t.length);
        paintTextLines(context, left, 625 + 3 * 38, width, 17, book.t.length + 7);
    } else {
        context.textAlign = 'left';
        paintTextLines(context, left, 230, width, 26, book.t.length + (back ? 3 : 11));
        context.fillStyle = '#8A7860';
        context.font = '500 22px "Geist Mono", monospace';
        context.textAlign = 'center';
        context.fillText(back ? '2' : '3', TEXTURE_WIDTH / 2, TEXTURE_HEIGHT - 110);
    }
    if (back) {
        const flipped = target.getContext('2d');
        flipped.translate(TEXTURE_WIDTH, 0);
        flipped.scale(-1, 1);
        flipped.drawImage(source, 0, 0);
    }
    return target;
}

function paintEdges() {
    const target = canvas(512, 64);
    const context = target.getContext('2d');
    context.fillStyle = '#EFE7D6';
    context.fillRect(0, 0, 512, 64);
    for (let y = 0; y < 64; y += 2) {
        context.fillStyle = `rgba(120,95,60,${0.08 + Math.random() * 0.12})`;
        context.fillRect(0, y, 512, 1);
    }
    return target;
}

function paintEndpaper() {
    const target = canvas(512, 732);
    const context = target.getContext('2d');
    context.fillStyle = '#E9E0CC';
    context.fillRect(0, 0, 512, 732);
    grain(context, 512, 732, 5000, 0.03);
    context.strokeStyle = 'rgba(120,90,50,.16)';
    context.lineWidth = 1;
    for (let x = -732; x < 512; x += 18) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x + 732, 732);
        context.stroke();
    }
    return target;
}

function paintWood() {
    if (woodCanvas) return woodCanvas;
    const target = canvas(1024, 1024);
    const context = target.getContext('2d');
    context.fillStyle = '#2A1C12';
    context.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 1400; i++) {
        const y = Math.random() * 1024;
        const alpha = 0.03 + Math.random() * 0.08;
        const amplitude = 2 + Math.random() * 6;
        const frequency = 0.004 + Math.random() * 0.006;
        const phase = Math.random() * 6;
        context.strokeStyle = Math.random() < 0.55
            ? `rgba(10,5,2,${alpha})`
            : `rgba(150,100,60,${alpha * 0.7})`;
        context.lineWidth = 0.6 + Math.random() * 2.2;
        context.beginPath();
        for (let x = 0; x <= 1024; x += 16) {
            const lineY = y + Math.sin(x * frequency + phase) * amplitude;
            if (x) context.lineTo(x, lineY);
            else context.moveTo(x, lineY);
        }
        context.stroke();
    }
    woodCanvas = target;
    return target;
}

function createPageGeometry(THREE, segments) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array((segments + 1) * 6);
    const uvs = new Float32Array((segments + 1) * 4);
    const indices = [];
    for (let i = 0; i <= segments; i++) {
        uvs.set([i / segments, 1, i / segments, 0], i * 4);
        if (i < segments) {
            const index = i * 2;
            indices.push(index, index + 1, index + 2, index + 2, index + 1, index + 3);
        }
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.userData.segments = segments;
    return geometry;
}

function bendPage(geometry, progress, lift) {
    const segments = geometry.userData.segments;
    const positions = geometry.attributes.position.array;
    const landing = Math.PI + 0.125 - lift;
    const theta = landing * progress;
    const curl = Math.sin(Math.PI * progress) * 0.95;
    const segmentLength = PAGE_LENGTH / segments;
    let x = 0, y = 0;
    for (let i = 0; i <= segments; i++) {
        const position = i / segments;
        positions[i * 6] = x;
        positions[i * 6 + 1] = y;
        positions[i * 6 + 2] = -BOOK_HEIGHT / 2 + 0.035;
        positions[i * 6 + 3] = x;
        positions[i * 6 + 4] = y;
        positions[i * 6 + 5] = BOOK_HEIGHT / 2 - 0.035;
        const angle = theta - curl * position ** 1.4 + 0.18 * Math.sin(Math.PI * progress) * (1 - position);
        x += Math.cos(angle) * segmentLength;
        y += Math.sin(angle) * segmentLength;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
}

function createBook(THREE, source, anisotropy) {
    const book = bookData(source);
    const group = new THREE.Group();
    const resources = [];
    const material = options => {
        const created = new THREE.MeshStandardMaterial(options);
        resources.push(created);
        for (const key of ['map', 'roughnessMap']) if (options[key]) resources.push(options[key]);
        return created;
    };
    const mesh = (geometry, faceMaterial) => {
        const created = new THREE.Mesh(geometry, faceMaterial);
        created.castShadow = true;
        created.receiveShadow = true;
        resources.push(geometry);
        return created;
    };
    const texture = (sourceCanvas, anisotropy, srgb = true) => {
        const created = new THREE.CanvasTexture(sourceCanvas);
        if (srgb) created.encoding = THREE.sRGBEncoding;
        created.anisotropy = anisotropy;
        return created;
    };
    const cloth = material({ color: new THREE.Color(book.bg).convertSRGBToLinear(), roughness: 0.82 });
    const cover = material({
        map: texture(paintCover(book), anisotropy),
        roughnessMap: texture(paintCover(book, true), anisotropy, false),
        roughness: 1,
    });
    const endpaper = material({ map: texture(paintEndpaper(), anisotropy), roughness: 0.9 });
    const edges = material({ map: texture(paintEdges(), anisotropy), roughness: 0.95 });
    const pageTop = material({ map: texture(paintPage('body', book), anisotropy), roughness: 0.92 });
    const back = mesh(new THREE.BoxGeometry(BOOK_WIDTH, COVER_THICKNESS, BOOK_HEIGHT), cloth);
    back.position.set(BOOK_WIDTH / 2, COVER_THICKNESS / 2, 0);
    group.add(back);
    const spine = mesh(new THREE.BoxGeometry(COVER_THICKNESS * 1.3, PAGE_THICKNESS + COVER_THICKNESS * 2, BOOK_HEIGHT), cloth);
    spine.position.set(-COVER_THICKNESS * 0.65, (PAGE_THICKNESS + COVER_THICKNESS * 2) / 2, 0);
    group.add(spine);
    const block = mesh(
        new THREE.BoxGeometry(PAGE_LENGTH, PAGE_THICKNESS, BOOK_HEIGHT - 0.07),
        [edges, edges, pageTop, pageTop, edges, edges],
    );
    block.position.set(PAGE_LENGTH / 2 + 0.012, COVER_THICKNESS + PAGE_THICKNESS / 2, 0);
    group.add(block);
    const hinge = new THREE.Group();
    hinge.position.set(0, COVER_THICKNESS + PAGE_THICKNESS, 0);
    group.add(hinge);
    const front = mesh(
        new THREE.BoxGeometry(BOOK_WIDTH, COVER_THICKNESS, BOOK_HEIGHT),
        [cloth, cloth, cover, endpaper, cloth, cloth],
    );
    front.position.set(BOOK_WIDTH / 2 + 0.006, COVER_THICKNESS / 2 + 0.0025, 0);
    hinge.add(front);
    const pages = [];
    [['title', 'edition-back'], ['chapter', 'body-back']].forEach(([face, reverse], index) => {
        const geometry = createPageGeometry(THREE, 36);
        resources.push(geometry);
        const frontPage = new THREE.Mesh(
            geometry,
            material({ map: texture(paintPage(face, book), anisotropy), roughness: 0.9, side: THREE.FrontSide }),
        );
        const reversePage = new THREE.Mesh(
            geometry,
            material({ map: texture(paintPage(reverse, book), anisotropy), roughness: 0.9, side: THREE.BackSide }),
        );
        frontPage.castShadow = reversePage.castShadow = true;
        frontPage.receiveShadow = reversePage.receiveShadow = true;
        const page = new THREE.Group();
        page.position.set(0.012, COVER_THICKNESS + PAGE_THICKNESS + 0.0008 * (2 - index), 0);
        page.add(frontPage, reversePage);
        group.add(page);
        pages.push({ geometry, lift: index * 0.007 });
        bendPage(geometry, 0, index * 0.007);
    });

    return {
        group,
        set(open, flips) {
            hinge.rotation.z = open * (Math.PI + 0.14);
            pages.forEach((page, index) => bendPage(page.geometry, flips[index] || 0, page.lift));
        },
        dispose() {
            resources.forEach(resource => resource.dispose?.());
        },
    };
}

function createStage(THREE, canvasElement, options) {
    const renderer = new THREE.WebGLRenderer({
        canvas: canvasElement,
        antialias: true,
        powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.dpr));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene();
    const background = new THREE.Color('#0D1210');
    scene.background = background;
    scene.fog = new THREE.Fog(background, 5.5, 13);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
    const anisotropy = renderer.capabilities.getMaxAnisotropy();
    const wood = new THREE.CanvasTexture(paintWood());
    wood.encoding = THREE.sRGBEncoding;
    wood.wrapS = wood.wrapT = THREE.RepeatWrapping;
    wood.repeat.set(3, 3);
    const tableMaterial = new THREE.MeshStandardMaterial({
        map: wood,
        roughness: 0.62,
        metalness: 0,
        color: 0xB89C82,
    });
    const table = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), tableMaterial);
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    scene.add(table);
    scene.add(new THREE.HemisphereLight(0xFFEEDD, 0x140E0A, 0.42));
    const spot = new THREE.SpotLight(0xFFD6A0, 2.3, 18, 0.62, 0.75, 1.4);
    spot.position.set(-2.4, 5.6, 2.2);
    spot.castShadow = true;
    spot.shadow.mapSize.set(options.shadow, options.shadow);
    spot.shadow.bias = -0.0004;
    spot.shadow.normalBias = 0.02;
    scene.add(spot, spot.target);
    const rim = new THREE.DirectionalLight(0x9DB4D8, 0.32);
    rim.position.set(4, 3, -3);
    scene.add(rim);
    let currentBook = null;
    return {
        camera,
        spot,
        get book() { return currentBook; },
        resize() {
            const width = canvasElement.clientWidth, height = canvasElement.clientHeight;
            if (!width || !height) return;
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        },
        setBook(data) {
            if (currentBook) {
                scene.remove(currentBook.group);
                currentBook.dispose();
            }
            currentBook = createBook(THREE, data, anisotropy);
            currentBook.group.traverse(node => {
                if (node.isMesh) {
                    node.castShadow = true;
                    node.receiveShadow = true;
                }
            });
            scene.add(currentBook.group);
        },
        render() {
            renderer.render(scene, camera);
        },
        dispose() {
            currentBook?.dispose();
            table.geometry.dispose();
            tableMaterial.dispose();
            wood.dispose();
            renderer.dispose();
        },
    };
}

function makeFallback(cover, book) {
    if (!cover) return;
    cover.style.backgroundColor = book.bg;
    cover.style.backgroundImage = `url("${paintCover(book).toDataURL('image/jpeg', 0.85)}")`;
    cover.setAttribute('aria-label', `${book.t} by ${book.a}`);
}

export function mountStorefront3d({ hero, viewer, scrollRoot, scene, stage, beats, onProgress }) {
    const THREE = window.THREE;
    const heroBook = bookData({
        t: 'Ethiopia Unbound',
        a: 'J. E. Casely Hayford',
        y: 1911,
        bg: '#1f3b2d',
        fg: '#efe9dc',
    });
    const fallback = hero?.parentElement?.querySelector('#fallback');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ticks = scrollRoot?.querySelectorAll('.rail-prog span') || [];
    const cue = scrollRoot?.querySelector('#cue');
    let heroStage = null, viewerStage = null;
    let heroProgress = 0, heroShown = 0, viewerTime = 0;
    let heroPointer = { x: 0, y: 0, smoothX: 0, smoothY: 0 };
    let viewerRotation = { y: -0.5, velocity: 0, dragging: false, lastX: 0 };
    let activeBook = null, frameId = 0, previousTime = 0, running = false, disposed = false;
    let heroVisible = true;
    const THREEReady = Boolean(THREE && hero && hero.getContext);

    const drawBeats = progress => {
        beats.forEach((beat, index) => {
            const start = Number(beat.dataset.a);
            const end = Number(beat.dataset.b);
            const opacity = reducedMotion
                ? (index === 0 ? 1 : 0)
                : clamp(Math.min(index === 0 ? 1 : segment(progress, start - 0.06, start + 0.02), 1 - segment(progress, end - 0.06, end)));
            beat.style.opacity = opacity.toFixed(3);
            beat.style.visibility = opacity < 0.01 ? 'hidden' : 'visible';
            const content = beat.querySelector('.in');
            if (content) content.style.transform = `translateY(${((1 - opacity) * 18).toFixed(1)}px)`;
        });
        const active = progress < 0.27 ? 0 : progress < 0.6 ? 1 : 2;
        ticks.forEach((tick, index) => tick.classList.toggle('on', index === active));
        if (cue) cue.style.opacity = (1 - segment(progress, 0, 0.06)).toFixed(3);
        onProgress(progress);
    };
    const updateScroll = () => {
        if (!scene || !stage || !scrollRoot) return;
        if (reducedMotion) {
            heroProgress = 1;
        } else {
            const rootRect = scrollRoot.getBoundingClientRect();
            const start = scene.getBoundingClientRect().top - rootRect.top + scrollRoot.scrollTop;
            const travel = Math.max(1, scene.offsetHeight - stage.offsetHeight);
            heroProgress = clamp((scrollRoot.scrollTop - start) / travel);
        }
        drawBeats(heroProgress);
        kick();
    };
    const initialize = () => {
        if (disposed) return;
        if (!THREEReady) {
            console.error('Quiet Chapters 3D is unavailable because Three.js or WebGL could not be loaded.');
            scrollRoot?.classList.add('no3d');
            makeFallback(fallback, heroBook);
            return;
        }
        try {
            heroStage = createStage(THREE, hero, {
                dpr: 1.75,
                shadow: window.innerWidth < 760 ? 1024 : 2048,
            });
            heroStage.setBook(heroBook);
            heroStage.resize();
            kick();
        } catch (error) {
            console.error('Unable to initialize the Quiet Chapters hero renderer:', error);
            scrollRoot?.classList.add('no3d');
            makeFallback(fallback, heroBook);
        }
    };
    const ensureViewer = () => {
        if (viewerStage || !viewer || !THREEReady) return;
        try {
            viewerStage = createStage(THREE, viewer, { dpr: 2, shadow: 2048 });
            viewerStage.setBook(activeBook || heroBook);
            viewerStage.resize();
        } catch (error) {
            console.error('Unable to initialize the Quiet Chapters book viewer:', error);
        }
    };
    const updateDimensions = () => {
        heroStage?.resize();
        viewerStage?.resize();
        updateScroll();
        kick();
    };
    const renderHero = delta => {
        if (!heroStage) return false;
        heroShown = reducedMotion ? heroProgress : damp(heroShown, heroProgress, 8, delta);
        heroPointer.smoothX = damp(heroPointer.smoothX, heroPointer.x, 3, delta);
        heroPointer.smoothY = damp(heroPointer.smoothY, heroPointer.y, 3, delta);
        const progress = heroShown;
        const open = ease(segment(progress, 0.2, 0.5));
        const firstPage = ease(segment(progress, 0.5, 0.8));
        const turn = ease(segment(progress, 0, 0.45));
        heroStage.book.set(open, [firstPage, 0]);
        const group = heroStage.book.group;
        group.rotation.y = lerp(-0.42, 0, turn);
        const aspect = heroStage.camera.aspect;
        const narrow = aspect < 0.9;
        const center = BOOK_WIDTH / 2 * (1 - open);
        const targetX = center + (narrow ? 0 : lerp(-1.05, -0.95, progress));
        const targetZ = narrow ? -0.85 : 0.05;
        const distance = narrow ? 1.25 + (0.9 - aspect) * 1.1 : 1;
        const cameraX = lerp(1.6, 0.15, ease(segment(progress, 0, 0.7)));
        const cameraY = lerp(6.4, 4.1, ease(segment(progress, 0, 0.75)));
        const cameraZ = lerp(4.6, 3.1, ease(segment(progress, 0, 0.8)));
        heroStage.camera.position.set(
            targetX + (cameraX + heroPointer.smoothX * 0.5) * distance,
            cameraY * distance - heroPointer.smoothY * 0.3,
            targetZ + cameraZ * distance,
        );
        heroStage.camera.lookAt(targetX, 0.12, targetZ);
        heroStage.spot.target.position.set(center, 0, 0);
        heroStage.render();
        return Math.abs(heroShown - heroProgress) > 0.0005
            || Math.abs(heroPointer.smoothX - heroPointer.x) > 0.001
            || Math.abs(heroPointer.smoothY - heroPointer.y) > 0.001;
    };
    const renderViewer = delta => {
        if (!viewerStage || !viewer || viewer.getBoundingClientRect().width === 0) return false;
        viewerTime += delta;
        if (!viewerRotation.dragging) {
            viewerRotation.velocity *= Math.exp(-4 * delta);
            viewerRotation.y += viewerRotation.velocity * delta;
            if (viewerTime < 2.8) viewerRotation.y = damp(viewerRotation.y, 0, 1.6, delta);
        }
        viewerRotation.y = clamp(viewerRotation.y, -1.1, 1.1);
        const open = ease(segment(viewerTime, 0.35, 1.55));
        const firstPage = ease(segment(viewerTime, 1.35, 2.5));
        viewerStage.book.set(open, [firstPage, 0]);
        const group = viewerStage.book.group;
        const center = BOOK_WIDTH / 2 * (1 - open);
        group.position.x = -center;
        group.rotation.y = viewerRotation.y;
        const distance = Math.max(1, 1.35 / viewerStage.camera.aspect) * lerp(0.86, 1, open);
        viewerStage.camera.position.set(0.15 * distance, 4.3 * distance, 3 * distance);
        viewerStage.camera.lookAt(0, 0, 0.08);
        viewerStage.render();
        return viewerTime < 3 || viewerRotation.dragging || Math.abs(viewerRotation.velocity) > 0.002;
    };
    const frame = now => {
        if (disposed) return;
        const delta = Math.min(0.05, (now - previousTime) / 1000);
        previousTime = now;
        const heroBusy = heroVisible && renderHero(delta);
        const viewerBusy = renderViewer(delta);
        if (heroBusy || viewerBusy) {
            frameId = requestAnimationFrame(frame);
        } else {
            running = false;
        }
    };
    function kick() {
        if (!running && !disposed) {
            running = true;
            previousTime = performance.now();
            frameId = requestAnimationFrame(frame);
        }
    }
    const moveHero = event => {
        const rect = stage.getBoundingClientRect();
        heroPointer.x = (event.clientX - rect.left) / rect.width - 0.5;
        heroPointer.y = (event.clientY - rect.top) / rect.height - 0.5;
        kick();
    };
    const startDrag = event => {
        if (event.target.closest('button')) return;
        viewerRotation.dragging = true;
        viewerRotation.lastX = event.clientX;
        viewer.setPointerCapture?.(event.pointerId);
    };
    const dragBook = event => {
        if (!viewerRotation.dragging) return;
        const delta = (event.clientX - viewerRotation.lastX) / Math.max(1, viewer.clientWidth) * 3.2;
        viewerRotation.lastX = event.clientX;
        viewerRotation.y += delta;
        viewerRotation.velocity = delta * 60;
        kick();
    };
    const endDrag = () => { viewerRotation.dragging = false; };
    const onVisibilityChange = () => {
        if (document.hidden) {
            cancelAnimationFrame(frameId);
            running = false;
        } else {
            kick();
        }
    };
    const intersection = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(entries => {
            heroVisible = entries[0].isIntersecting;
            if (heroVisible) kick();
        }, { root: scrollRoot })
        : null;

    if (!THREEReady) {
        initialize();
    } else {
        const fontsReady = document.fonts?.load
            ? Promise.race([
                Promise.all([
                    '500 100px Newsreader',
                    'italic 400 30px Newsreader',
                    '500 30px "Geist Mono"',
                    '500 20px Geist',
                ].map(font => document.fonts.load(font).catch(() => undefined))),
                new Promise(resolve => setTimeout(resolve, 2500)),
            ])
            : Promise.resolve();
        fontsReady.then(initialize);
    }
    hero?.addEventListener('pointermove', moveHero);
    viewer?.addEventListener('pointerdown', startDrag);
    viewer?.addEventListener('pointermove', dragBook);
    viewer?.addEventListener('pointerup', endDrag);
    viewer?.addEventListener('pointercancel', endDrag);
    viewer?.addEventListener('lostpointercapture', endDrag);
    scrollRoot?.addEventListener('scroll', updateScroll, { passive: true });
    window.addEventListener('resize', updateDimensions, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    intersection?.observe(stage);
    updateScroll();

    return {
        setBook(book) {
            activeBook = bookData(book);
            viewerTime = 0;
            viewerRotation.y = -0.5;
            viewerRotation.velocity = 0;
            if (viewerStage) viewerStage.setBook(activeBook);
        },
        refresh() {
            ensureViewer();
            viewerStage?.resize();
            viewerTime = 0;
            kick();
        },
        replay() {
            viewerTime = 0;
            viewerRotation.y = -0.55;
            viewerRotation.velocity = 0;
            kick();
        },
        dispose() {
            disposed = true;
            cancelAnimationFrame(frameId);
            intersection?.disconnect();
            hero?.removeEventListener('pointermove', moveHero);
            viewer?.removeEventListener('pointerdown', startDrag);
            viewer?.removeEventListener('pointermove', dragBook);
            viewer?.removeEventListener('pointerup', endDrag);
            viewer?.removeEventListener('pointercancel', endDrag);
            viewer?.removeEventListener('lostpointercapture', endDrag);
            scrollRoot?.removeEventListener('scroll', updateScroll);
            window.removeEventListener('resize', updateDimensions);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            heroStage?.dispose();
            viewerStage?.dispose();
            scrollRoot?.classList.remove('no3d');
        },
    };
}
