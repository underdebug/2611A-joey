#version 450

layout(push_constant) uniform Transform {
    float angle;
    float aspect;
} transform;

layout(location = 0) out vec3 color;

// The vertex index supplies three vertices without a vertex buffer.
const vec2 positions[3] = vec2[3](
    vec2(0.0, -0.65), vec2(0.563, 0.325), vec2(-0.563, 0.325));
const vec3 colors[3] = vec3[3](
    vec3(1.0, 0.25, 0.35), vec3(0.25, 1.0, 0.55), vec3(0.25, 0.5, 1.0));

void main()
{
    float c = cos(transform.angle);
    float s = sin(transform.angle);
    vec2 p = mat2(c, s, -s, c) * positions[gl_VertexIndex];
    // Preserve proportions in both wide and tall windows.
    p.x /= max(transform.aspect, 1.0);
    p.y *= min(transform.aspect, 1.0);
    gl_Position = vec4(p, 0.0, 1.0);
    color = colors[gl_VertexIndex];
}
