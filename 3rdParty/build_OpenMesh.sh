
git clone --recursive https://gitlab.vci.rwth-aachen.de:9000/OpenMesh/OpenMesh.git
cd OpenMesh/ 

mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Debug
make -j4
