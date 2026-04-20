#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Compile SKILL.md + all reference files into a single self-contained file.

Usage:
    python scripts/compile.py                     # writes to compiled_skill.md
    python scripts/compile.py -o my_output.md     # custom output path

Why: For AI clients that don't support progressive disclosure (loading
reference files on demand), this script inlines everything into one file
so the LLM gets full context in a single read.
"""
import argparse
import os
import glob


SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_file(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read().strip()


def collect_md_files(directory: str) -> list[tuple[str, str]]:
    """Return sorted list of (filename, content) for all .md files in a dir."""
    pattern = os.path.join(SKILL_ROOT, directory, "*.md")
    files = sorted(glob.glob(pattern))
    return [(os.path.basename(f), read_file(f)) for f in files]


def compile_skill(output_path: str):
    skill_path = os.path.join(SKILL_ROOT, "SKILL.md")
    skill_content = read_file(skill_path)

    references = collect_md_files("references")
    assets = collect_md_files("assets")

    parts = [skill_content, "", "---", ""]

    if references:
        parts.append("# Inlined Reference Files")
        parts.append("")
        for filename, content in references:
            parts.append(f"## references/{filename}")
            parts.append("")
            parts.append(content)
            parts.append("")
            parts.append("---")
            parts.append("")

    if assets:
        parts.append("# Inlined Asset Files")
        parts.append("")
        for filename, content in assets:
            parts.append(f"## assets/{filename}")
            parts.append("")
            parts.append(content)
            parts.append("")
            parts.append("---")
            parts.append("")

    compiled = "\n".join(parts)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(compiled)

    ref_count = len(references)
    asset_count = len(assets)
    line_count = compiled.count("\n") + 1
    print(f"Compiled SKILL.md + {ref_count} references + {asset_count} assets")
    print(f"Output: {output_path} ({line_count} lines)")


def main():
    parser = argparse.ArgumentParser(description="Compile skill into a single self-contained file")
    parser.add_argument("-o", "--output",
                        default=os.path.join(SKILL_ROOT, "compiled_skill.md"),
                        help="Output file path (default: compiled_skill.md)")
    args = parser.parse_args()
    compile_skill(args.output)


if __name__ == "__main__":
    main()
