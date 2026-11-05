cd_cargo() {
  local run=$1
  if [ -n "$run" ]; then
    shift
  fi

  while true; do
    if [[ -f "Cargo.toml" ]]; then
      if [ -n "$run" ]; then
        $run "$@"
      fi
      return
    fi

    shopt -s nullglob
    local dirs=(*/)
    shopt -u nullglob

    local found=0
    for dir in "${dirs[@]}"; do
      if [[ -f "${dir}Cargo.toml" ]]; then
        found=1
        if [ -n "$run" ]; then
          echo "> $dir"
          (cd "$dir" && $run "$@") || return $?
        fi
      fi
    done

    if [[ $found -eq 1 ]]; then
      return
    fi

    local current_dir=$(pwd)
    cd ..
    if [[ "$(pwd)" == "$current_dir" || -d "$current_dir/.git" ]]; then
      echo "❌ Cargo.toml not found" >&2
      exit 1
    fi
  done
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  cd_cargo "$@"
fi
