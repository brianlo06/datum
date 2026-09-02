// 2020 extrusion corner bracket
// A right-angle bracket for bolting two lengths of 2020 aluminium extrusion
// together. Written as a Datum seed part: everything configurable is declared
// with Customizer annotations, and it depends on no external libraries.

/* [Bracket] */
// Length of each arm
arm = 40; // [20:5:80]
// Thickness of the bracket body
thickness = 5; // [3:0.5:10]
// Width across the bracket
width = 20; // [10:1:40]

/* [Fasteners] */
// Bolt diameter
bolt_d = 5; // [3:0.5:8]
// Distance from the inside corner to the first hole
first_hole = 20; // [10:1:30]
// Bolt holes per arm
holes = 1; // [1:1:3]
// Centre-to-centre spacing between holes
hole_pitch = 20; // [10:1:40]

/* [Reinforcement] */
// Add a triangular gusset between the arms
gusset = true;
// Gusset thickness
gusset_t = 3; // [2:0.5:6]

/* [Hidden] */
eps = 0.01;
$fn = 48;

module arm_holes() {
    for (i = [0 : holes - 1])
        translate([first_hole + i * hole_pitch, width / 2, -eps])
            cylinder(d = bolt_d, h = thickness + 2 * eps);
}

// The gusset must stop short of the first bolt hole, or the bolt cannot be
// fitted. Deriving its length from first_hole keeps that true at every setting
// rather than only at the defaults.
gusset_len = max(thickness + 2, min(arm * 0.6, first_hole - bolt_d));

module gusset_shape() {
    translate([0, (width + gusset_t) / 2, 0])
        rotate([90, 0, 0])
            linear_extrude(gusset_t)
                polygon([
                    [thickness, thickness],
                    [gusset_len, thickness],
                    [thickness, gusset_len]
                ]);
}

// The last hole must sit fully inside the arm. Without this, an over-ambitious
// hole count silently produces a bracket with a slot cut out of its end -- the
// kind of quiet wrongness you only discover after printing it.
assert(
    first_hole + (holes - 1) * hole_pitch + bolt_d / 2 <= arm - 1,
    "The last bolt hole falls outside the arm. Lengthen the arm, or reduce holes, hole_pitch or first_hole."
);

module bracket() {
    difference() {
        union() {
            cube([arm, width, thickness]);
            cube([thickness, width, arm]);
            if (gusset) gusset_shape();
        }
        // Holes through the horizontal arm, drilled downwards.
        arm_holes();
        // Holes through the vertical arm, drilled sideways.
        // Note: the range must start at 0. `[1 : holes - 1]` looks like a way to
        // skip the first hole, but when holes == 1 that is [1:0], and OpenSCAD
        // reverses a backwards range rather than iterating zero times.
        for (i = [0 : holes - 1])
            translate([-eps, width / 2, first_hole + i * hole_pitch])
                rotate([0, 90, 0])
                    cylinder(d = bolt_d, h = thickness + 2 * eps);
    }
}

bracket();
