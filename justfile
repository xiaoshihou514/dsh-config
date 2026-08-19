dsh := env_var_or_default("DSH_BIN", "dsh")

default:
    @just --list

# Install dependencies, rebuild generated output, then link this checkout.
install:
    pnpm install
    {{dsh}} plugin --profile web add "{{justfile_directory()}}"

format:
    prettier -w **/*.md **/*.js **/*.ts **/*.tsx **/*.css **/*.yaml **/*.json
