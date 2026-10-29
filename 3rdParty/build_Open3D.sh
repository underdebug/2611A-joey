git clone https://github.com/isl-org/Open3D.git
cd Open3D

# 2. Install dependencies
sudo ./util/install_deps_ubuntu.sh

# 3. Create build directory
mkdir build
cd build

# 4. Configure
cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_PYTHON_MODULE=OFF \
    -DBUILD_CUDA_MODULE=OFF \
    -DCMAKE_INSTALL_PREFIX=$HOME/open3d_install

# 5. Compile
make -j$(nproc)

# 6. Install
make install