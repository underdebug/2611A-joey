
git clone --recursive https://github.com/baldurk/renderdoc.git
cd renderdoc

mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Debug
make -j4

make install
