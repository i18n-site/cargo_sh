while [[ ! -f "Cargo.toml" ]]; do
  current_dir=$(pwd)
  cd ..
  if [[ "$(pwd)" == "$current_dir" ]]; then
    echo "❌ Cargo.toml not found"
    break
  fi
done
