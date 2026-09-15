# Function to solve the crossword

from copy import copy, deepcopy
from word_list import make_word_list
from numba import njit
from wordlists import gen_wordlists
import itertools

import time
import datetime
import numpy as np
import sys
import string #import ascii_upperrcase
import pdb
sys.path.append(r'C:\Users\psatt\AppData\Local\Packages\PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0\LocalCache\local-packages\Python311\site-packages')

from pytrie import StringTrie

class TrieNode:
    def __init__(self):
        self.children = {}
        self.is_end_of_word = False

def initialize_grid(rows, cols):
    return np.full((rows, cols), ' ', dtype='<U1')

def traverse_trie(node, prefix):
    if node.is_end_of_word:
        print(prefix)
    for char, child in node.children.items():
        traverse_trie(child, prefix + char)

def solve_crossword(xw, seed):
    wordList, wordsInPuzzle = make_word_list(xw, seed)
    numWords, wordDataBase_list, wordDataBase = gen_wordlists(0, -1)
    tags = (''.join(c) for c in itertools.product('ABCDEFGHIJKLMNOPQRSTUVWXYZ', repeat=3))
    slots = []
    tagval = 1
    for word in wordList:
        tag = next(tags)
        row = word[0]
        col = word[1]
        length = word[3]
        direction = "across" if word[2] == 1 else "down"
        initial_word = word[4]
        #print(word[4])
        slot = Slot(str(tagval), row, col, length, direction, initial_word)  # Create Slot object
        slots.append(slot)  # Append Slot object
        tagval = tagval+1
    # Print for debugging
    #print(slots)  # Now prints a list of Slot objects
    word_dict = sum(wordDataBase_list, [])
    solver = CrosswordCSP(slots, word_dict)  # Now passing correct format
    print("starting solve")
    #print(solver.constraints)
    solution = solver.solve()
    print("Final grid:")
    solver.print_grid(solution)
class Slot:
    def __init__(self, name, row, col, length, direction, word):
        self.name = name           # Unique identifier (e.g., "A1", "D3")
        self.row = row             # Starting row
        self.col = col             # Starting column
        self.length = length       # Word length
        self.direction = direction  # "across" or "down"
        self.intersections = []    # List of (other_slot, self_index, other_index)
        self.constraints = []
        self.init_word = word

    def intersects(self, other):
        """Check if this slot intersects with another slot and store intersection details."""
        for i in range(self.length):
            r, c = (self.row, self.col + i) if self.direction == "across" else (self.row + i, self.col)
            for j in range(other.length):
                r2, c2 = (other.row, other.col + j) if other.direction == "across" else (other.row + j, other.col)
                if r == r2 and c == c2:  # Same grid position
                    self.intersections.append((other, i, j))
                    other.intersections.append((self, j, i))
                    return True  # Slots intersect
        return False

    def intersect_position(self, other):
        """Return the indices in self and other where they intersect."""
        for i in range(self.length):
            r, c = (self.row, self.col + i) if self.direction == "across" else (self.row + i, self.col)

            for j in range(other.length):
                r2, c2 = (other.row, other.col + j) if other.direction == "across" else (other.row + j, other.col)

                if r == r2 and c == c2:  # Found the intersection point
                    return i, j  # Return the index in self and index in other
        return None  # No intersection found

    def __repr__(self):
        return f"Slot({self.name}, {self.row}, {self.col}, {self.length}, {self.direction})"
    
class CrosswordCSP:
    def __init__(self, slots, word_dict):
        if not all(isinstance(slot, Slot) for slot in slots):
            raise TypeError("All elements in 'slots' must be instances of Slot class")

        self.slots = slots
        self.domains = {slot: set(self.get_words_of_length(slot.length, word_dict)) for slot in slots}
        self.create_constraints()  # Now populates each slot's constraints
        self.start_time = time.time()
        self.last_print_time = self.start_time

    def get_words_of_length(self, length, word_dict):
        """Return a list of words of the correct length from the dictionary."""
        return [word for word in word_dict if len(word) == length]

    def create_constraints(self):
        """Assign constraints to each slot instead of using a global list."""
        for s1 in self.slots:
            s1.constraints = []  # Each slot gets its own constraints list

            for s2 in self.slots:
                if s1 != s2 and s1.intersects(s2):
                    i1, i2 = s1.intersect_position(s2)
                    s1.constraints.append((s2, i1, i2))
                    s2.constraints.append((s1, i2, i1))  # Ensure bi-directional constraints

    def is_consistent(self, assignment, slot, word, depth=1):
        """Check if assigning 'word' to 'slot' is consistent with its constraints,
        including checking three steps ahead for valid crossing words."""
        
        if word in assignment.values():
            return False  # Avoid duplicate words

        for other_slot, i_word, i_other in slot.constraints:
            if other_slot in assignment:
                intersecting_word = assignment[other_slot]
                if intersecting_word[i_other] != word[i_word]:  
                    return False  
            else:
                valid_words = [ #needs to also check for otherh spots in the grid!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
                    w for w in self.domains[other_slot]
                    if w[i_other] == word[i_word]
                ]
                if not valid_words:
                    return False  

                # If we have additional depth to check, ensure these valid crossing words are also consistent
                if depth > 1:
                    assignment[slot] = word

                    for crossing_word in valid_words:
                        # Check the consistency of the crossing word by calling is_consistent recursively
                        if not self.is_consistent(assignment, other_slot, crossing_word, depth - 1):
                            return False  
                    del assignment[other_slot]

        return True



    def get_crossing_word_count(self, word, slot, assignment):
        """Finds the minimum number of valid crossing words for a given word in the given slot."""
        assignment[slot] = word
        min_crossing_count = float('inf')

        for other_slot, i_word, i_other in slot.constraints:
            if len(word) <= i_word:
                continue 

            if other_slot in assignment:
                intersecting_word = assignment[other_slot]
                if len(intersecting_word) > i_other and intersecting_word[i_other] == word[i_word]:
                    crossing_word_count = len(self.domains[other_slot])
                else:
                    crossing_word_count = 0  
            else:
                valid_crossing_words = [
                    w for w in self.domains[other_slot] if len(w) > i_other and w[i_other] == word[i_word]
                ]
                crossing_word_count = len(valid_crossing_words)

            min_crossing_count = min(min_crossing_count, crossing_word_count)

        del assignment[slot]
        return min_crossing_count if min_crossing_count != float('inf') else 0

    def backtrack(self, assignment):
        if len(assignment) == len(self.slots):
            return assignment  # Solution found

        slot = self.select_unassigned_variable(assignment)
        ranked_words = sorted(
            [word for word in self.domains[slot] if self.is_consistent(assignment, slot, word)],
            key=lambda word: self.get_crossing_word_count(word, slot, assignment),
            reverse=True
        )

        current_time = time.time()
        if current_time - self.last_print_time >= 2:  # Adjust interval (seconds)
            print(f"\nTime elapsed: {int(current_time - self.start_time)}s")
            self.print_grid(assignment)
            self.last_print_time = current_time  # Update last print time
        
        removed_words = {}  # Store removed words for backtracking
        for word in ranked_words:
            assignment[slot] = word
            # Apply forward checking
            if self.forward_check(slot, word, assignment, removed_words):
                result = self.backtrack(assignment)
                if result:
                    return result

            # Undo assignment and restore removed words
            del assignment[slot]
            for s in removed_words:
                self.domains[s].update(removed_words[s])  # Restore words

        return None  # No solution found from this path


    def solve(self):
        """Solve the crossword using backtracking."""
        initial_assignment = {slot: slot.init_word for slot in self.slots if slot.init_word != ''}
        #print(initial_assignment)
        # Start the backtracking process with the initial assignments
        return self.backtrack(initial_assignment)

    def select_unassigned_variable(self, assignment):
        """Select the next unassigned slot using the Minimum Remaining Values (MRV) heuristic."""
        
        # If nothing is assigned, just pick the slot with the smallest domain (MRV) first
        if not assignment:
            # Select the slot with the smallest domain size and print for debugging
            mrv_slot = min(self.slots, key=lambda s: len(self.domains[s]))
            return mrv_slot

        # Otherwise, select the unassigned slot with the smallest domain size (MRV)
        unassigned_slots = [s for s in self.slots if s not in assignment]
        mrv_slot = min(unassigned_slots, key=lambda s: len(self.domains[s]))  # Slot with smallest domain size

        return mrv_slot


    def get_valid_words(self, slot, assignment):
        """Finds all valid words for the given slot based on current constraints."""
        return [word for word in self.domains[slot] if self.is_consistent(assignment, slot, word)]

    def print_grid(self, assignment):
        """Prints the crossword grid based on the current word assignment."""
        max_row = max(slot.row + (slot.length if slot.direction == "down" else 1) for slot in self.slots)
        max_col = max(slot.col + (slot.length if slot.direction == "across" else 1) for slot in self.slots)
        grid = [[' ' for _ in range(max_col)] for _ in range(max_row)]

        for slot, word in assignment.items():
            r, c = slot.row, slot.col
            for i, letter in enumerate(word):
                if slot.direction == "across":
                    grid[r][c + i] = letter
                else:
                    grid[r + i][c] = letter

        for row in grid:
            print(' '.join(row))

    def forward_check(self, slot, word, assignment, removed_words):
        """
        Prune the domains of intersecting slots based on the current word assignment.
        If any domain becomes empty, return False (causing early backtracking).
        Otherwise, return True.
        
        Parameters:
        - slot: The slot being assigned a word.
        - word: The word being assigned to the slot.
        - assignment: The current assignment of words to slots.
        - removed_words: A dictionary tracking words removed from domains (for backtracking).
        """
        for other_slot, i_word, i_other in slot.constraints:
            if other_slot in assignment:
                continue  # Skip already assigned slots

            # Store removed words for backtracking
            removed_words[other_slot] = removed_words.get(other_slot, [])

            # Filter out words in other_slot's domain that don't match the intersection
            valid_words = [
                w for w in self.domains[other_slot] if w[i_other] == word[i_word]
            ]

            # Track removed words
            removed_words[other_slot].extend(self.domains[other_slot] - set(valid_words))

            # Update the domain
            self.domains[other_slot] = set(valid_words)

            # If any slot has no valid words left, return False (triggering backtracking)
            if not self.domains[other_slot]:
                return False

        return True  # Forward check passed