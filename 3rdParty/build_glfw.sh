
git clone https://github.com/g-truc/glm.git

cd glm/

git clone https://github.com/g-truc/glm.git
cd glm
cmake -S . -B build
cmake --build build -j$(nproc)
sudo cmake --install build
