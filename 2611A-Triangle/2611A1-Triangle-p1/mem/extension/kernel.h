
#pragma once

#include <cmath>
#include <cstddef>
#include <algorithm>
#include <vector>

#define __constant__
#define __global__
#define __host__
#define __device__

struct cudaGraphicsResource;

// CPU counterparts for the CUDA library declarations used by replayed code.
using cudaError_t = int;
using cublasStatus_t = int;
using cusparseStatus_t = int;
using cublasHandle_t = void*;
using cusparseHandle_t = void*;

namespace thrust {
template<class T, class Allocator = std::allocator<T>>
class device_vector : public std::vector<T, Allocator> {
public:
    using std::vector<T, Allocator>::vector;
};
template<class T, class Allocator = std::allocator<T>>
using host_vector = std::vector<T, Allocator>;
template<class T> T* raw_pointer_cast(T* pointer) { return pointer; }
using std::remove;
}

struct float2 { float x, y; };
inline float2 make_float2(float x, float y) { return {x, y}; }

struct dim3 {
    unsigned int x, y, z;
    constexpr dim3(unsigned int x = 1, unsigned int y = 1, unsigned int z = 1)
        : x(x), y(y), z(z) {}
    dim3 operator * (const dim3& dim)
    {
        x *= dim.x;
        y *= dim.y;
        z *= dim.z;
        return *this;
    }
    dim3 operator / (const int div) const
    {
        return dim3(x / div, y / div, z / div);
    }
};

inline thread_local dim3 gridDim, blockDim, blockIdx, threadIdx;
template<class F> void run_kernel(dim3 grid, dim3 block, F function) {
    const dim3 blockDimOld = blockDim, blockIdxOld = blockIdx, threadIdxOld = threadIdx;
    blockDim = block;
    const dim3 offset = grid / 2;

    for (unsigned int z = 0; z < grid.z; ++z)
    for (unsigned int y = 0; y < grid.y; ++y)
    for (unsigned int x = 0; x < grid.x; ++x)
    for (threadIdx.z = 0; threadIdx.z < block.z; ++threadIdx.z)
    for (threadIdx.y = 0; threadIdx.y < block.y; ++threadIdx.y)
    for (threadIdx.x = 0; threadIdx.x < block.x; ++threadIdx.x) {
        blockIdx = dim3((x + offset.x) % grid.x, (y + offset.y) % grid.y, (z + offset.z) % grid.z);
        function();
    }
    blockDim = blockDimOld; blockIdx = blockIdxOld; threadIdx = threadIdxOld;
}

struct CpuTexture3D {
    const float* data;
    int width, height, depth;
};
using cudaTextureObject_t = const CpuTexture3D*;

template <typename T>
inline T tex3D(cudaTextureObject_t texture, float x, float y, float z) {
    if (!texture || !std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z)
        || x <= -0.5f || y <= -0.5f || z <= -0.5f
        || x >= texture->width + 0.5f || y >= texture->height + 0.5f
        || z >= texture->depth + 0.5f) return T{};
    x -= 0.5f; y -= 0.5f; z -= 0.5f;
    const int ix = static_cast<int>(std::floor(x));
    const int iy = static_cast<int>(std::floor(y));
    const int iz = static_cast<int>(std::floor(z));
    const float fx = x - ix, fy = y - iy, fz = z - iz;
    T result{};
    for (int dz = 0; dz < 2; ++dz)
        for (int dy = 0; dy < 2; ++dy)
            for (int dx = 0; dx < 2; ++dx) {
                const int cx = ix + dx, cy = iy + dy, cz = iz + dz;
                if (cx < 0 || cy < 0 || cz < 0 || cx >= texture->width
                    || cy >= texture->height || cz >= texture->depth) continue;
                const float weight = (dx ? fx : 1 - fx)
                    * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
                result += static_cast<T>(weight * texture->data[
                    (static_cast<std::size_t>(cz) * texture->height + cy)
                    * texture->width + cx]);
            }
    return result;
}

