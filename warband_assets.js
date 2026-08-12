// warband_assets.js - client-side Warband asset resolution.
//
// texture_server.py is now a generic raw-file server (GET /list/<relpath> ->
// filenames in that dir under WARBAND_ROOT; GET /raw/<relpath> -> raw file
// bytes). Every piece of Warband-specific interpretation that used to live in
// texture_server.py now lives here instead:
//   - .dds header parsing + compressed-texture (S3TC/DXT) upload, no PNG
//     conversion, no Pillow.
//   - .brf chunk parsing (mesh + material), a direct port of brf_parser.py -
//     see that file's own docstring for the format's provenance (OpenBRF's
//     published C++ source, ground-truthed against a real hex-dump).
//   - scene_props.txt parsing, including the sokf_invisible (0x4000) flag
//     check (header_scene_props.py, real module-system source) that decides
//     whether a prop's mesh should render at all - barriers/limiters/climb-
//     boundary markers ship a real mesh for in-editor display that the real
//     game never draws.
//   - materials.brf name -> diffuse-texture resolution.
//   - the module-overrides-base-game search-directory priority order used
//     for both textures and meshes.
"use strict";

const WarbandAssets = (function () {
  const SEARCH_DIRS = [
    "Modules/Napoleonic Wars/Textures",
    "TexturesHD",
    "Textures",
  ];
  const SEARCH_BRF_DIRS = [
    "Modules/Napoleonic Wars/Resource",
    "CommonRes",
  ];
  const SCENE_PROPS_TXT = "Modules/Napoleonic Wars/scene_props.txt";
  const SOKF_INVISIBLE = 0x4000;

  function encPath(relpath) {
    return relpath.split("/").map(encodeURIComponent).join("/");
  }
  async function listDir(relpath) {
    try {
      const r = await fetch("/list/" + encPath(relpath));
      if (!r.ok) return [];
      return await r.json();
    } catch (e) {
      return [];
    }
  }
  async function fetchRawBytes(relpath) {
    const r = await fetch("/raw/" + encPath(relpath));
    if (!r.ok) throw new Error("404: " + relpath);
    return await r.arrayBuffer();
  }
  async function fetchRawText(relpath) {
    const buf = await fetchRawBytes(relpath);
    const bytes = new Uint8Array(buf);
    let s = "";
    // latin-1 decode (matches the previous server's encoding="latin-1") -
    // every byte maps 1:1 to the same-valued code point.
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  // ==================== .brf parsing (port of brf_parser.py) ====================

  function makeCursor(buf) {
    return { view: new DataView(buf), bytes: new Uint8Array(buf), offset: 0, length: buf.byteLength };
  }
  function cU32(c) { const v = c.view.getUint32(c.offset, true); c.offset += 4; return v; }
  function cI32(c) { const v = c.view.getInt32(c.offset, true); c.offset += 4; return v; }
  function cF32(c) { const v = c.view.getFloat32(c.offset, true); c.offset += 4; return v; }
  function cU8(c) { const v = c.view.getUint8(c.offset); c.offset += 1; return v; }
  function cString(c) {
    const n = cU32(c);
    if (n === 0) return "";
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(c.bytes[c.offset + i]);
    c.offset += n;
    return s;
  }
  // Raw on-disk (v0,v1,v2) triple, deliberately NOT remapped to any render
  // convention - see brf_parser.py's _point3 docstring for why (callers
  // compose this with an entity's own engine-space rotation matrix first,
  // then do ONE single engine-to-render remap on the fully-composed point).
  function cPoint3(c) { return [cF32(c), cF32(c), cF32(c)]; }
  // BrfVert::Load flips V: ta[1] = 1 - ta[1].
  function cPoint2UV(c) { const u = cF32(c); const v = cF32(c); return [u, 1.0 - v]; }
  function cSkip(c, n) { c.offset += n; }

  function loadTextureChunk(c) {
    cString(c); // name (unused - texture resolution goes through the search-dir/materials chain)
    cU32(c); // flags
  }
  function loadShaderChunk(c) {
    cString(c); // name
    cU32(c); // flags
    cU32(c); // requires
    cString(c); // technique
    const k = cU32(c);
    if (k) cString(c); // fallback
    const nOpt = cU32(c);
    cSkip(c, nOpt * 16); // BrfShaderOpt = 4 x (int/uint) = 16 bytes
  }
  function loadMaterialChunk(c) {
    const name = cString(c);
    cU32(c); // flags
    cString(c); // shader
    const diffuseA = cString(c);
    cString(c); // diffuseB
    cString(c); // bump
    cString(c); // enviro
    // LoadStringMaybe: only consumes bytes if the next u32 looks like a
    // short valid length (1..98); otherwise no-op (rewinds).
    const pos = c.offset;
    const n = cU32(c);
    if (n >= 1 && n <= 98) {
      cSkip(c, n);
    } else {
      c.offset = pos;
    }
    cF32(c); cF32(c); cF32(c); cF32(c); // specular, r, g, b
    return { name, diffuseA };
  }
  function skipTmpRigging(c) {
    const outer = cU32(c);
    for (let i = 0; i < outer; i++) {
      cI32(c); // bindex
      const pairs = cU32(c);
      cSkip(c, pairs * 8); // TmpRiggingPair::SizeOnDisk() == 8
    }
  }
  function vertSize(globVersion) {
    if (globVersion === 0) return 4 + 4 + 12 + 8 + 8;
    if (globVersion === 1) return 4 + 4 + 12 + 12 + 1 + 8;
    return 4 + 4 + 12 + 8;
  }
  function loadMeshChunk(c, state, wantGeometry) {
    const name = cString(c);
    const flags = cU32(c);
    const material = cString(c);

    if (state.version !== 0) {
      state.globVersion = (flags & (1 << 16)) ? 1 : 2;
    }
    const globVersion = state.globVersion;

    const posCount = cU32(c);
    let positions = [];
    if (wantGeometry) {
      for (let i = 0; i < posCount; i++) positions.push(cPoint3(c));
    } else {
      cSkip(c, posCount * 12);
    }

    skipTmpRigging(c);

    const k = cI32(c); // extra vertex-animation frames beyond frame 0
    for (let i = 0; i < k; i++) {
      cI32(c); // time
      const c1 = cU32(c); cSkip(c, c1 * 12);
      const c2 = cU32(c); cSkip(c, c2 * 12);
    }

    const vertCount = cU32(c);
    const vsize = vertSize(globVersion);
    let verts = [];
    if (wantGeometry) {
      for (let i = 0; i < vertCount; i++) {
        const index = cI32(c);
        cU32(c); // col
        const norm = cPoint3(c);
        let uv;
        if (globVersion === 0) {
          uv = cPoint2UV(c);
          cPoint2UV(c); // tb, unused
        } else if (globVersion === 1) {
          cPoint3(c); // tang
          cU8(c); // tangi
          uv = cPoint2UV(c);
        } else {
          uv = cPoint2UV(c);
        }
        verts.push({ posIndex: index, normal: norm, uv: uv });
      }
    } else {
      cSkip(c, vertCount * vsize);
    }

    const faceCount = cU32(c);
    let faces = [];
    if (wantGeometry) {
      for (let i = 0; i < faceCount; i++) {
        faces.push([cI32(c), cI32(c), cI32(c)]);
      }
    } else {
      cSkip(c, faceCount * 12);
    }

    return { name, material, flags, positions, verts, faces };
  }

  // Parses one .brf ArrayBuffer. Returns {meshes: [...], materials: {name: diffuseA}}.
  // meshNameFilter (optional Set of lowercase names): only fully extracts
  // geometry for meshes in that set (still records name/material for the
  // rest) - lets a caller do a cheap indexing pass while still getting
  // exactly the mesh it wants in the same pass if desired.
  function parseBRF(buf, wantGeometry, meshNameFilter) {
    const meshes = [];
    const materials = {};
    const state = { version: 0, globVersion: 0 };
    const c = makeCursor(buf);
    try {
      while (true) {
        if (c.offset >= c.length) break;
        let tag;
        try {
          tag = cString(c);
        } catch (e) {
          break;
        }
        if (tag === "end" || tag === "") break;
        else if (tag === "rfver ") {
          state.version = cI32(c);
          state.globVersion = state.version;
        } else if (tag === "texture") {
          const n = cU32(c);
          for (let i = 0; i < n; i++) loadTextureChunk(c);
        } else if (tag === "shader") {
          const n = cU32(c);
          for (let i = 0; i < n; i++) loadShaderChunk(c);
        } else if (tag === "material") {
          const n = cU32(c);
          for (let i = 0; i < n; i++) {
            const m = loadMaterialChunk(c);
            materials[m.name] = m.diffuseA;
          }
        } else if (tag === "mesh") {
          const n = cU32(c);
          for (let i = 0; i < n; i++) {
            let want = wantGeometry;
            if (meshNameFilter) {
              const peekPos = c.offset;
              const nm = cString(c);
              c.offset = peekPos;
              want = meshNameFilter.has(nm.toLowerCase());
            }
            const m = loadMeshChunk(c, state, want);
            meshes.push(m);
          }
        } else if (tag === "skeleton" || tag === "skeleton_anim" || tag === "body") {
          break;
        } else {
          break;
        }
      }
    } catch (e) {
      // Matches brf_parser.py's broad except: stops cleanly, returns what's
      // been read so far.
    }
    return { meshes, materials };
  }

  // Expands a parsed mesh's indexed (position-index + per-corner normal/uv)
  // representation into flat position/normal/uv arrays, one entry per vert.
  function meshToRenderGeometry(mesh) {
    const positions = mesh.positions;
    const verts = mesh.verts;
    const outPos = [], outNorm = [], outUV = [];
    for (const v of verts) {
      const p = (v.posIndex >= 0 && v.posIndex < positions.length) ? positions[v.posIndex] : [0, 0, 0];
      outPos.push(p[0], p[1], p[2]);
      outNorm.push(v.normal[0], v.normal[1], v.normal[2]);
      outUV.push(v.uv[0], v.uv[1]);
    }
    const indices = [];
    for (const f of mesh.faces) indices.push(f[0], f[1], f[2]);
    return { positions: outPos, normals: outNorm, uvs: outUV, indices };
  }

  // Mirrors BrfMesh::AnalyzeName: splits "basename.lodN[.piece]".
  function analyzeName(name) {
    const dot = name.indexOf(".");
    if (dot < 0) return { base: name, lod: 0, piece: -1 };
    const base = name.slice(0, dot);
    const suffix = name.slice(dot).toLowerCase();
    let m = suffix.match(/^\.lod(\d+)\.(\d+)$/);
    if (m) return { base, lod: parseInt(m[1], 10), piece: parseInt(m[2], 10) };
    m = suffix.match(/^\.(\d+)$/);
    if (m) return { base, lod: 0, piece: parseInt(m[1], 10) };
    m = suffix.match(/^\.lod(\d+)$/);
    if (m) return { base, lod: parseInt(m[1], 10), piece: -1 };
    return { base: name, lod: 0, piece: -1 };
  }

  // ==================== DDS parsing + S3TC/DXT compressed-texture upload ====================

  const DDPF_FOURCC = 0x4;
  const FOURCC_DXT1 = 0x31545844, FOURCC_DXT3 = 0x33545844, FOURCC_DXT5 = 0x35545844;

  function parseDDS(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x20534444) throw new Error("not a DDS file"); // 'DDS '
    const height = dv.getUint32(12, true);
    const width = dv.getUint32(16, true);
    const mipMapCountField = dv.getUint32(28, true);
    const mipMapCount = mipMapCountField || 1;
    const pfFlags = dv.getUint32(80, true);
    const fourCC = dv.getUint32(84, true);
    if (!(pfFlags & DDPF_FOURCC)) throw new Error("uncompressed DDS not supported");
    let blockBytes, format;
    if (fourCC === FOURCC_DXT1) { blockBytes = 8; format = "DXT1"; }
    else if (fourCC === FOURCC_DXT3) { blockBytes = 16; format = "DXT3"; }
    else if (fourCC === FOURCC_DXT5) { blockBytes = 16; format = "DXT5"; }
    else throw new Error("unsupported DDS fourCC 0x" + fourCC.toString(16));

    let offset = 128; // 4-byte magic + 124-byte header, no DX10 extension header
    const mips = [];
    let w = width, h = height;
    for (let i = 0; i < mipMapCount; i++) {
      const blocksW = Math.max(1, Math.ceil(w / 4));
      const blocksH = Math.max(1, Math.ceil(h / 4));
      const size = blocksW * blocksH * blockBytes;
      if (offset + size > buf.byteLength) break;
      mips.push({ width: w, height: h, data: new Uint8Array(buf, offset, size) });
      offset += size;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    return { width, height, format, mips };
  }

  let s3tcExt; // undefined = not checked yet, null = checked, unavailable
  function getS3TCExt(gl) {
    if (s3tcExt === undefined) {
      s3tcExt = gl.getExtension("WEBGL_compressed_texture_s3tc")
        || gl.getExtension("WEBKIT_WEBGL_compressed_texture_s3tc")
        || gl.getExtension("MOZ_WEBGL_compressed_texture_s3tc")
        || null;
    }
    return s3tcExt;
  }

  // Uploads a parsed DDS's full mip chain (as shipped in the file - real
  // game textures ship pre-baked mips, so generateMipmap - which WebGL1
  // disallows for compressed formats anyway - is never needed) onto an
  // existing WebGLTexture. Returns true on success, false if S3TC isn't
  // available or the format is unsupported (caller should keep its flat-tint
  // fallback in that case).
  function uploadDDSTexture(gl, tex, dds, tile) {
    const ext = getS3TCExt(gl);
    if (!ext) return false;
    const enumFor = {
      DXT1: ext.COMPRESSED_RGBA_S3TC_DXT1_EXT,
      DXT3: ext.COMPRESSED_RGBA_S3TC_DXT3_EXT,
      DXT5: ext.COMPRESSED_RGBA_S3TC_DXT5_EXT,
    };
    const glFmt = enumFor[dds.format];
    if (!glFmt || dds.mips.length === 0) return false;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (let i = 0; i < dds.mips.length; i++) {
      const m = dds.mips[i];
      gl.compressedTexImage2D(gl.TEXTURE_2D, i, glFmt, m.width, m.height, 0, m.data);
    }
    const hasMips = dds.mips.length > 1;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, hasMips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (tile) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    return true;
  }

  // ==================== search-dir-priority texture name index ====================

  let textureIndexPromise = null;
  async function buildTextureIndex() {
    // Maps lowercase-no-extension name -> relpath, first dir in SEARCH_DIRS
    // wins (module-overrides-base-game priority) - built by listing each dir
    // in REVERSE order so the first dir's entries overwrite later ones.
    const index = {};
    const dirs = SEARCH_DIRS.slice().reverse();
    for (const d of dirs) {
      const names = await listDir(d);
      for (const fname of names) {
        if (fname.toLowerCase().endsWith(".dds")) {
          index[fname.slice(0, -4).toLowerCase()] = d + "/" + fname;
        }
      }
    }
    return index;
  }
  function getTextureIndex() {
    if (!textureIndexPromise) textureIndexPromise = buildTextureIndex();
    return textureIndexPromise;
  }

  // ==================== .brf mesh/material index across SEARCH_BRF_DIRS ====================

  let meshIndexPromise = null;
  async function buildMeshIndex() {
    const meshIndex = {}; // lowercase base name -> [{brf, name, lod, piece, material}]
    const materialCatalog = {}; // material name -> diffuse texture name
    for (const d of SEARCH_BRF_DIRS) {
      const names = (await listDir(d)).filter(n => n.toLowerCase().endsWith(".brf")).sort();
      // Parallelize within a directory - these are local/fast, but there can
      // be hundreds of files; a full Promise.all keeps startup from being
      // needlessly serial.
      const results = await Promise.all(names.map(async fname => {
        const relpath = d + "/" + fname;
        try {
          const buf = await fetchRawBytes(relpath);
          return { relpath, parsed: parseBRF(buf, false, null) };
        } catch (e) {
          return { relpath, parsed: { meshes: [], materials: {} } };
        }
      }));
      for (const { relpath, parsed } of results) {
        for (const [mname, diffuse] of Object.entries(parsed.materials)) {
          if (!(mname in materialCatalog)) materialCatalog[mname] = diffuse;
        }
        for (const m of parsed.meshes) {
          const { base, lod, piece } = analyzeName(m.name);
          const key = base.toLowerCase();
          if (!meshIndex[key]) meshIndex[key] = [];
          meshIndex[key].push({ brf: relpath, name: m.name, lod, piece, material: m.material });
        }
      }
    }
    return { meshIndex, materialCatalog };
  }
  function getMeshIndex() {
    if (!meshIndexPromise) meshIndexPromise = buildMeshIndex();
    return meshIndexPromise;
  }

  // ==================== scene_props.txt ====================

  let scenePropsPromise = null;
  async function buildScenePropsMap() {
    // entity name -> {mesh: baseNameOrNull, flags: rawSokfBitmask}
    const result = {};
    let text;
    try {
      text = await fetchRawText(SCENE_PROPS_TXT);
    } catch (e) {
      return result;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("spr_")) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 4) continue;
      const flags = parseInt(parts[1], 10) || 0;
      result[parts[0]] = { mesh: parts[3] === "0" ? null : parts[3], flags };
    }
    return result;
  }
  function getScenePropsMap() {
    if (!scenePropsPromise) scenePropsPromise = buildScenePropsMap();
    return scenePropsPromise;
  }

  // ==================== public API ====================

  const geometryCache = new Map(); // "brf|meshName" -> geometry dict or null

  async function getMeshPieces(baseName) {
    const { meshIndex, materialCatalog } = await getMeshIndex();
    const entries = meshIndex[baseName.toLowerCase()];
    if (!entries || !entries.length) return [];
    const minLod = Math.min(...entries.map(e => e.lod));
    const pieces = entries.filter(e => e.lod === minLod);

    const out = [];
    for (const e of pieces) {
      const cacheKey = e.brf + "|" + e.name;
      if (!geometryCache.has(cacheKey)) {
        let g = null;
        try {
          const buf = await fetchRawBytes(e.brf);
          const perFile = parseBRF(buf, true, new Set([e.name.toLowerCase()]));
          const match = perFile.meshes.find(m => m.name === e.name);
          if (match) {
            const geo = meshToRenderGeometry(match);
            const diffuse = materialCatalog[e.material] || e.material;
            g = { positions: geo.positions, normals: geo.normals, uvs: geo.uvs, indices: geo.indices, texture: diffuse };
          }
        } catch (err) { /* leave g null */ }
        geometryCache.set(cacheKey, g);
      }
      const g = geometryCache.get(cacheKey);
      if (g) out.push(g);
    }
    return out;
  }

  // name: either a scene_props.txt entity name or a raw mesh base name.
  // Returns {pieces: [{positions,normals,uvs,indices,textureName}, ...]} -
  // NOTE: "textureName" not "textureUrl" (no more server-rendered PNG URL;
  // callers resolve+decode the texture themselves via resolveAndLoadTexture).
  async function getMeshData(name) {
    const propsMap = await getScenePropsMap();
    let meshName;
    if (Object.prototype.hasOwnProperty.call(propsMap, name)) {
      const entry = propsMap[name];
      if (entry.mesh === null || (entry.flags & SOKF_INVISIBLE)) return { pieces: [] };
      meshName = entry.mesh;
    } else {
      meshName = name;
    }
    const pieces = await getMeshPieces(meshName);
    return {
      pieces: pieces.map(p => ({
        positions: p.positions, normals: p.normals, uvs: p.uvs, indices: p.indices,
        textureName: p.texture.toLowerCase(),
      })),
    };
  }

  // Resolves a texture NAME (not filename) to raw .dds bytes, per the
  // module-overrides-base-game search order, falling back through
  // materials.brf's name->diffuse binding if there's no direct file match
  // (ground_specs.txt's texture-name column is sometimes a material name,
  // not a raw filename - see texture_server.py's original docstring for the
  // confirmed examples: stone_a/patch_rock/grassy_ground).
  async function resolveTextureBytes(name) {
    const lower = name.toLowerCase();
    const index = await getTextureIndex();
    let relpath = index[lower];
    if (!relpath) {
      const { materialCatalog } = await getMeshIndex();
      const diffuse = materialCatalog[name] || materialCatalog[lower];
      if (diffuse) relpath = index[diffuse.toLowerCase()];
    }
    if (!relpath) return null;
    return fetchRawBytes(relpath);
  }

  // Fetches + decodes a texture by name and uploads it onto `tex` (an
  // already-created WebGLTexture, e.g. from a 1x1 fallback-color texture the
  // caller made). Resolves to true if a real texture was uploaded, false if
  // it was left as whatever `tex` already contained (not found, or S3TC
  // unavailable).
  async function loadTextureOnto(gl, tex, name, tile) {
    let buf;
    try {
      buf = await resolveTextureBytes(name);
    } catch (e) {
      return false;
    }
    if (!buf) return false;
    let dds;
    try {
      dds = parseDDS(buf);
    } catch (e) {
      return false;
    }
    return uploadDDSTexture(gl, tex, dds, tile);
  }

  return {
    SOKF_INVISIBLE,
    getMeshData,
    loadTextureOnto,
    resolveTextureBytes,
    parseDDS,
    uploadDDSTexture,
    // exposed for debugging from the browser console
    _internal: { getTextureIndex, getMeshIndex, getScenePropsMap, parseBRF, meshToRenderGeometry, analyzeName },
  };
})();
