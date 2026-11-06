# Blender intro for the demo video: 3D gold "BAZAAR SOVEREIGN" rising out of the dark,
# warm rim light, drifting spice-dust motes and a slow camera push-in. 4 s at 30 fps, 1920x1080.
# Run: blender -b -P tools/video/intro.py -- <out_dir>   (writes <out_dir>/intro_####.png)
import bpy, math, random, sys, os

out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'art-src/video/intro'
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1920, 1080, 100
sc.render.fps = 30
sc.frame_start, sc.frame_end = 1, 120
try: sc.eevee.taa_render_samples = 48
except Exception: pass
sc.render.image_settings.file_format = 'PNG'
sc.render.filepath = os.path.join(out, 'intro_')
sc.view_settings.view_transform = 'Standard'  # keeps the gold saturated

# world: deep warm dark
world = bpy.data.worlds.new('dusk'); sc.world = world; world.use_nodes = True
bg = world.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.018, 0.010, 0.006, 1); bg.inputs[1].default_value = 1.0

def mat(name, color, metallic=0.0, rough=0.4, emit=None, strength=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metallic
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = strength
    return m

gold = mat('gold', (1.0, 0.62, 0.2), metallic=1.0, rough=0.3)
cream = mat('cream', (0.95, 0.88, 0.72), rough=0.6, emit=(0.95, 0.85, 0.65), strength=0.35)
dust = mat('dust', (1.0, 0.55, 0.15), emit=(1.0, 0.45, 0.1), strength=3.0)

font = None
for f in (r'C:\Windows\Fonts\georgiab.ttf', r'C:\Windows\Fonts\timesbd.ttf'):
    if os.path.exists(f): font = bpy.data.fonts.load(f); break

def text(body, size, z, material, extrude, bevel):
    bpy.ops.object.text_add(location=(0, 0, z))
    t = bpy.context.object; t.data.body = body
    if font: t.data.font = font
    t.data.align_x, t.data.align_y = 'CENTER', 'CENTER'
    t.data.size, t.data.extrude, t.data.bevel_depth, t.data.bevel_resolution = size, extrude, bevel, 3
    t.rotation_euler = (math.radians(90), 0, 0)
    t.data.materials.append(material)
    return t

title = text('BAZAAR SOVEREIGN', 0.5, 0.2, gold, 0.06, 0.012)
sub = text('every merchant is an NFT that owns its own NEAR wallet', 0.15, -0.38, cream, 0.0, 0.0)

# title rises and turns to face the camera; subtitle fades up after it
title.location.z, title.rotation_euler.x = -0.45, math.radians(40)
title.keyframe_insert('location', index=2, frame=1); title.keyframe_insert('rotation_euler', index=0, frame=1)
title.location.z, title.rotation_euler.x = 0.2, math.radians(90)
title.keyframe_insert('location', index=2, frame=42); title.keyframe_insert('rotation_euler', index=0, frame=42)
sub.scale = (0.001, 0.001, 0.001); sub.keyframe_insert('scale', frame=48)
sub.scale = (1, 1, 1); sub.keyframe_insert('scale', frame=66)

# lights: warm key, orange rim from behind, cool faint fill
def light(kind, loc, rot, energy, color, size=2.0):
    d = bpy.data.lights.new(kind + str(loc), kind); d.energy, d.color = energy, color
    if kind == 'AREA': d.size = size
    o = bpy.data.objects.new(d.name, d); o.location, o.rotation_euler = loc, [math.radians(a) for a in rot]
    sc.collection.objects.link(o); return d
key = light('AREA', (-2.5, -5, 2.5), (60, 0, -25), 700, (1.0, 0.8, 0.55), 5)
light('AREA', (2.5, 3, 1.5), (-70, 0, 145), 500, (1.0, 0.42, 0.12), 4)
light('AREA', (3, -5, -1.5), (110, 0, 30), 350, (1.0, 0.7, 0.4), 4)
light('AREA', (4, -3, -1), (95, 0, 50), 120, (0.55, 0.65, 1.0), 3)
key.energy = 0; key.keyframe_insert('energy', frame=1); key.energy = 700; key.keyframe_insert('energy', frame=36)

# spice dust: small glowing motes drifting upward through the frame
random.seed(7)
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.012)
mote = bpy.context.object; mote.data.materials.append(dust); mote.hide_render = True; mote.hide_viewport = True
for i in range(70):
    o = mote.copy(); sc.collection.objects.link(o); o.hide_render = o.hide_viewport = False
    x, y, z = random.uniform(-5.5, 5.5), random.uniform(-2.5, 3.0), random.uniform(-2.6, 1.4)
    s = random.uniform(0.5, 1.6); o.scale = (s, s, s)
    o.location = (x, y, z); o.keyframe_insert('location', frame=1)
    o.location = (x + random.uniform(-0.3, 0.3), y, z + random.uniform(0.6, 1.4)); o.keyframe_insert('location', frame=120)

# camera: slow push-in
cam_d = bpy.data.cameras.new('cam'); cam_d.lens = 50
cam = bpy.data.objects.new('cam', cam_d); sc.collection.objects.link(cam); sc.camera = cam
cam.rotation_euler = (math.radians(90), 0, 0)
cam.location = (0, -9.0, 0.0); cam.keyframe_insert('location', frame=1)
cam.location = (0, -7.6, -0.02); cam.keyframe_insert('location', frame=120)

# smooth easing on every animated property
for o in bpy.data.objects:
    ad = o.animation_data
    if ad and ad.action:
        for fc in getattr(ad.action, 'fcurves', []):
            for k in fc.keyframe_points: k.interpolation = 'BEZIER'

bpy.ops.render.render(animation=True)
print('INTRO_DONE', out)
