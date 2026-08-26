default:
    @just --list

# Install dependencies, rebuild generated output, then link this checkout.
install:
    pnpm install
    pnpm run build
    dsh plugin --profile web add "{{justfile_directory()}}"

format:
    prettier -w **/*.md **/*.js **/*.ts **/*.tsx **/*.css **/*.yaml **/*.json
