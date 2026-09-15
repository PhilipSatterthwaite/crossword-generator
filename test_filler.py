import pytest

from filler import WordList, check_fill, fill, parse_grid
from sample_grids import SAMPLE_GRIDS


def tiny(words):
    return WordList((word, 1.0) for word in words)


def test_parse_finds_all_entries_with_clue_numbers():
    _, _, _, slots = parse_grid(SAMPLE_GRIDS["themed15"])
    assert len(slots) == 76
    assert [s.name for s in slots[:3]] == ["1-Across", "1-Down", "2-Down"]


def test_lone_cells_are_not_entries():
    _, _, _, slots = parse_grid(["#.#", "...", "#.#"])
    assert sorted((s.row, s.col, s.direction, len(s.cells)) for s in slots) == [(0, 1, "down", 3), (1, 0, "across", 3)]


def test_orphan_empty_cell_is_reported():
    result = fill(["...", "###", "#.#"], tiny(["CAT"]))
    assert not result.success
    assert "row 2, col 1" in result.reason


def test_missing_word_length_is_reported():
    result = fill(["....."], tiny(["CAT"]))
    assert not result.success
    assert "5-letter" in result.reason


def test_fills_small_square():
    words = tiny(["TAB", "ONE", "PET", "TOP", "ANE", "BET", "CAT", "DOG", "EGG"])
    grid = ["...", "...", "..."]
    result = fill(grid, words, seed=0)
    assert result.success, result.reason
    assert check_fill(grid, result.grid, words) == []


def test_keeps_given_letters():
    words = tiny(["TAB", "ONE", "PET", "TOP", "ANE", "BET", "CAT", "DOG", "EGG"])
    grid = ["..P", "...", "..."]
    result = fill(grid, words)
    assert result.success, result.reason
    assert result.grid[0] == list("TOP")
    assert check_fill(grid, result.grid, words) == []


def test_never_repeats_a_word():
    # Six entries but only three words, so any fill would need repeats.
    result = fill(["...", "...", "..."], tiny(["BAT", "ARE", "TEN"]))
    assert not result.success
    assert "no fill exists" in result.reason


def test_given_entries_need_not_be_listed_words():
    words = tiny(["ZAP", "ZIP", "ZOO", "AIO", "PPO"])
    grid = ["ZZZ", "...", "..."]
    result = fill(grid, words)
    assert result.success, result.reason
    assert check_fill(grid, result.grid, words) == []


def test_check_fill_catches_bad_fills():
    words = tiny(["BAT", "ARE", "TEN"])
    problems = check_fill(["B..", "...", "..."], ["CAT", "ARE", "TEN"], words)
    assert problems == ["given letter B changed to C at row 0, col 0"]
    problems = check_fill(["...", "...", "..."], ["BAT", "ARE", "TEX"], words)
    assert "3-Down TEX is not in the word list" in problems
    assert "BAT is used twice (1-Across and 1-Down)" in problems


@pytest.fixture(scope="module")
def real_words():
    return WordList.from_folder()


@pytest.mark.parametrize("name", ["open5", "stair7", "themed15"])
def test_fills_sample_grids(real_words, name):
    grid = SAMPLE_GRIDS[name]
    result = fill(grid, real_words, time_limit=15, seed=1)
    assert result.success, result.reason
    assert check_fill(grid, result.grid, real_words) == []
