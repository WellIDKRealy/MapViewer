#!/usr/bin/env python3
"""
Minimal, read-only parser for Mount & Blade Warband .brf ("Binary Resource File")
mesh/material/texture chunks - enough to extract real static-mesh geometry
(positions/normals/uv/faces) and each mesh's referenced material name.

Format confirmed by cross-referencing OpenBRF's own C++ source
(github.com/cfcohen/openbrf: saveLoad.cpp, brfData.cpp, brfMesh.cpp/.h,
brfMaterial.cpp, brfShader.cpp, brfTexture.cpp) against a byte-level hex-dump of
a real materials.brf record (see texture_server.py's own materials.brf note) -
not guessed. Only the read path needed for STATIC (non-skinned, non-vertex-
animated) meshes is exercised/tested; skinning and vertex-animation-frame data
is parsed structurally (so byte offsets stay correct) but discarded.

Container layout (BrfData::Load): a sequence of (tag string, payload) chunks,
tag one of "rfver ", "texture", "shader", "material", "mesh", "skeleton",
"skeleton_anim", "body", terminated by tag "end". Every string field on disk is
a 4-byte little-endian byte count (NOT including any terminator) immediately
followed by that many raw bytes, with no gap between consecutive string
fields - confirmed via hex-dump AND matches saveLoad.cpp's LoadString/SaveString
exactly.
"""
import os
import struct

# -------------------- primitive readers --------------------

def _u32(f):
    return struct.unpack("<I", f.read(4))[0]


def _i32(f):
    return struct.unpack("<i", f.read(4))[0]


def _f32(f):
    return struct.unpack("<f", f.read(4))[0]


def _string(f):
    n = _u32(f)
    if n == 0:
        return ""
    return f.read(n).decode("latin-1", errors="replace")


def _point3(f):
    """Returns the RAW on-disk (v0,v1,v2) triple, deliberately NOT remapped to
    any render convention here. OpenBRF's own LoadPoint(Point3f&) assigns
    p.X=v0, p.Z=v1, p.Y=v2 into ITS OWN internal Y-up Point3f (confirmed in
    saveLoad.cpp) - which means disk order (v0,v1,v2) is ALREADY the engine's
    native (X,Y,Z) with no reordering on disk at all (OpenBRF's swap happens
    only when loading INTO its own tool-internal Y-up representation, which
    this parser doesn't use). Kept in native engine space so the caller
    (main2.html) can apply a .sco entity's own engine-space rotation matrix
    and position directly, then do ONE single engine-to-render remap on the
    fully-composed world point - exactly mirroring how entity positions and
    terrain heights are already remapped elsewhere in this project, instead of
    remapping twice (once here, once again after the rotation) and risking a
    sign error from composing two remaps."""
    return (_f32(f), _f32(f), _f32(f))


def _point2_uv(f):
    """BrfVert::Load flips V: ta[1] = 1 - ta[1]."""
    u = _f32(f); v = _f32(f)
    return (u, 1.0 - v)


def _skip(f, n):
    if n:
        f.seek(n, 1)


# -------------------- chunk-level readers --------------------

def _load_texture_chunk(f):
    _string(f)  # name (unused - texture resolution goes through texture_server's own dir search)
    _u32(f)  # flags


def _load_shader_chunk(f):
    _string(f)  # name
    _u32(f)  # flags
    _u32(f)  # requires
    _string(f)  # technique
    k = _u32(f)
    if k:
        _string(f)  # fallback
    n_opt = _u32(f)
    _skip(f, n_opt * 16)  # BrfShaderOpt = 4 x (int/uint) = 16 bytes


def _load_material_chunk(f):
    """Mirrors BrfMaterial::Load exactly (brfMaterial.cpp)."""
    name = _string(f)
    _u32(f)  # flags
    _string(f)  # shader
    diffuse_a = _string(f)
    _string(f)  # diffuseB
    _string(f)  # bump
    _string(f)  # enviro
    # spec: LoadStringMaybe - only consumes bytes if the next u32 looks like a
    # short valid length (1..98); otherwise it's a no-op (rewinds).
    pos = f.tell()
    n = _u32(f)
    if 1 <= n <= 98:
        f.read(n)
    else:
        f.seek(pos)
    _f32(f); _f32(f); _f32(f); _f32(f)  # specular, r, g, b
    return name, diffuse_a


def _skip_tmp_rigging(f):
    outer = _u32(f)
    for _ in range(outer):
        _i32(f)  # bindex
        pairs = _u32(f)
        _skip(f, pairs * 8)  # TmpRiggingPair::SizeOnDisk() == 8


def _vert_size(glob_version):
    if glob_version == 0:
        return 4 + 4 + 12 + 8 + 8
    elif glob_version == 1:
        return 4 + 4 + 12 + 12 + 1 + 8
    else:
        return 4 + 4 + 12 + 8


def _load_mesh_chunk(f, state, want_geometry):
    """Mirrors BrfMesh::Load (brfMesh.cpp). If want_geometry is False, only
    name/material/flags are extracted and the rest is skipped by seeking
    (fast index pass); positions/verts/faces are empty lists in that case."""
    name = _string(f)
    flags = _u32(f)
    material = _string(f)

    if state["version"] != 0:
        state["glob_version"] = 1 if (flags & (1 << 16)) else 2
    glob_version = state["glob_version"]

    pos_count = _u32(f)
    if want_geometry:
        positions = [_point3(f) for _ in range(pos_count)]
    else:
        positions = []
        _skip(f, pos_count * 12)

    _skip_tmp_rigging(f)

    k = _i32(f)  # extra vertex-animation frames beyond frame 0 (0 for static meshes)
    for _ in range(k):
        _i32(f)  # time
        c1 = _u32(f); _skip(f, c1 * 12)
        c2 = _u32(f); _skip(f, c2 * 12)

    vert_count = _u32(f)
    vsize = _vert_size(glob_version)
    verts = []
    if want_geometry:
        for _ in range(vert_count):
            index = _i32(f)
            _u32(f)  # col
            norm = _point3(f)
            if glob_version == 0:
                uv = _point2_uv(f)
                _point2_uv(f)  # tb, unused
            elif glob_version == 1:
                _point3(f)  # tang
                f.read(1)  # tangi
                uv = _point2_uv(f)
            else:
                uv = _point2_uv(f)
            verts.append({"posIndex": index, "normal": norm, "uv": uv})
    else:
        _skip(f, vert_count * vsize)

    face_count = _u32(f)
    faces = []
    if want_geometry:
        for _ in range(face_count):
            i0 = _i32(f); i1 = _i32(f); i2 = _i32(f)
            faces.append((i0, i1, i2))
    else:
        _skip(f, face_count * 12)

    return {
        "name": name,
        "material": material,
        "flags": flags,
        "positions": positions,
        "verts": verts,
        "faces": faces,
    }


def parse_brf(path, want_geometry=True, mesh_name_filter=None):
    """Parses one .brf file. Returns {"meshes": [...], "materials": {name: diffuseA}}.
    If mesh_name_filter is given (a set of lowercase names), only fully extracts
    geometry for meshes in that set (still records name/material for the rest) -
    lets a caller do a cheap pass while still getting exactly the mesh it wants.
    Stops cleanly (returns what's been read so far) on hitting a "skeleton"/
    "skeleton_anim"/"body" tag, EOF, or any parse error - by BrfData's own
    Save() convention these always come after all "mesh" chunks in a file, so
    nothing of interest is lost for the static-prop/vegetation meshes this
    parser targets.
    """
    meshes = []
    materials = {}
    state = {"version": 0, "glob_version": 0}
    try:
        with open(path, "rb") as f:
            while True:
                start = f.tell()
                try:
                    tag = _string(f)
                except Exception:
                    break
                if tag == "end" or tag == "":
                    break
                elif tag == "rfver ":
                    state["version"] = _i32(f)
                    state["glob_version"] = state["version"]
                elif tag == "texture":
                    n = _u32(f)
                    for _ in range(n):
                        _load_texture_chunk(f)
                elif tag == "shader":
                    n = _u32(f)
                    for _ in range(n):
                        _load_shader_chunk(f)
                elif tag == "material":
                    n = _u32(f)
                    for _ in range(n):
                        mname, diffuse = _load_material_chunk(f)
                        materials[mname] = diffuse
                elif tag == "mesh":
                    n = _u32(f)
                    for _ in range(n):
                        want = want_geometry
                        if mesh_name_filter is not None:
                            # Peek the name first (cheap: strings are self-delimiting)
                            peek_pos = f.tell()
                            nm = _string(f)
                            f.seek(peek_pos)
                            want = nm.lower() in mesh_name_filter
                        m = _load_mesh_chunk(f, state, want)
                        meshes.append(m)
                elif tag in ("skeleton", "skeleton_anim", "body"):
                    break
                else:
                    break
    except Exception:
        pass
    return {"meshes": meshes, "materials": materials}


def mesh_to_render_geometry(mesh):
    """Expands a parsed BrfMesh's indexed (position-index + per-corner normal/uv)
    representation into flat position/normal/uv arrays, one entry per BrfVert
    (matches how the real format stores it - normals/UVs are per-vert, not
    per-position, since a hard edge or UV seam needs the same position with
    different normals/UVs). Returns (positions[], normals[], uvs[], indices[])
    as flat Python lists ready for a WebGL buffer."""
    positions = mesh["positions"]
    verts = mesh["verts"]
    out_pos = []
    out_norm = []
    out_uv = []
    for v in verts:
        p = positions[v["posIndex"]] if 0 <= v["posIndex"] < len(positions) else (0.0, 0.0, 0.0)
        out_pos.extend(p)
        out_norm.extend(v["normal"])
        out_uv.extend(v["uv"])
    indices = []
    for (i0, i1, i2) in mesh["faces"]:
        indices.extend([i0, i1, i2])
    return out_pos, out_norm, out_uv, indices


def analyze_name(name):
    """Mirrors BrfMesh::AnalyzeName: splits "basename.lodN[.piece]" - returns
    (baseName, lodLevel, pieceIndex). lodLevel=0/pieceIndex=-1 if no suffix."""
    dot = name.find(".")
    if dot < 0:
        return name, 0, -1
    base = name[:dot]
    suffix = name[dot:].lower()
    import re
    m = re.match(r"^\.lod(\d+)\.(\d+)$", suffix)
    if m:
        return base, int(m.group(1)), int(m.group(2))
    m = re.match(r"^\.(\d+)$", suffix)
    if m:
        return base, 0, int(m.group(1))
    m = re.match(r"^\.lod(\d+)$", suffix)
    if m:
        return base, int(m.group(1)), -1
    return name, 0, -1
