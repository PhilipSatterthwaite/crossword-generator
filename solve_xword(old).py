# Function to solve the crossword

from copy import copy, deepcopy
from word_list import make_word_list
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

def traverse_trie(node, prefix):
    if node.is_end_of_word:
        print(prefix)
    for char, child in node.children.items():
        traverse_trie(child, prefix + char)

def solve_phase(xw, wordDataBase, wordList,wordsInPuzzle,lastPrint, numWords, wordDataBase_list):
    def recursive_solve(xw, wordListIndex, wordsInPuzzle, lastPrint):
        #set word parameters
        wordSlot = wordList[wordListIndex]
        #if all(' ' not in item for item in define_word(xw, wordSlot)):
        #    xw_new, did_solve = recursive_solve(xw, wordListIndex + 1,wordsInPuzzle, lastPrint)
        
        did_solve = False  # not solved initially
        
        # Determine the length of the word

        lengthIndex = wordSlot[3]-3
        #print(wordDataBase_list[lengthIndex][0])
        fit_words = make_list(xw, wordSlot, lengthIndex, wordsInPuzzle)#############
        if fit_words == None or fit_words == []:
            return xw, False

        sorted_list = deepcopy(fit_words) ##need to optimize sort_list function
        
        #sorted_list = sort_list(fit_words, xw, wordSlot, numWords, wordsInPuzzle)
        
        if sorted_list == None or sorted_list == []:
            return xw, False

        #add numbers to end of list
        for i in range(len(sorted_list)):
            sorted_list[i] = [sorted_list[i], 0]

        ########################  # Find the first word that fits
        for i in range(len(sorted_list)):  # loop through words
            
            test_word = sorted_list[i][0]
            
            
            if  test_word in wordsInPuzzle: #== test_word: #if word is in puzzle, skip
                continue
            
            #does_match = does_it_match(test_word, wordCompare) ######
############################
            
            #if does_match:  # if a word fits, delete the word from array, call the next word

            #update words in puzzle list
            wordsInPuzzleNew = deepcopy(wordsInPuzzle)
            wordsInPuzzleNew.append(test_word)
            
            # update xw
            xw_next = deepcopy(xw)
            xw_next = update_xw(xw_next, wordSlot, test_word)
            
            #check if grid is possible
            

            if wordListIndex+1 == len(wordList):
                return xw_next, True

            timeNow = deepcopy(time.time())
            #print every minute
            if  timeNow - lastPrint >= 60:
                lastPrint = deepcopy(timeNow)
                current_time = datetime.datetime.fromtimestamp(timeNow).time()
                print(current_time.strftime("%H:%M:%S"))
                for row in xw_next:
                    print(row)
                print()
                #continue ###################experiment (to try to get rid of clogging
            
            did_solve = True  # set to True now that this step is solved    (I think can delete this line)

                
            # call function for the next word
            #xw_new = deepcopy(xw_next)
            xw_new, did_solve = recursive_solve(xw_next, wordListIndex + 1,wordsInPuzzleNew, lastPrint)
            
            if did_solve:
                return xw_new, True

        return xw, False

    

    def make_list(xw, wordSlot, index, wordsInPuzzle):
        def matches_word(word, wordCompare):
            for w, l in zip(word, wordCompare):
                if l != ' ' and w != l:
                    return False
            return True

        trie = wordDataBase[index]
        fit_words = []
        wordCompare = define_word(xw, wordSlot)

        if all(char != ' ' for char in wordCompare):
            fit_words.append(wordCompare)
            return fit_words
        if all(char == ' ' for char in wordCompare):
            return wordDataBase_list[index]
        if wordCompare[0] == ' ':
            for letter in string.ascii_uppercase:
                prefix = letter
                for word, _ in trie.items(prefix=prefix):
                    if matches_word(word, wordCompare) and word not in wordsInPuzzle:
                        xw_next = update_xw(xw, wordSlot, word)
                        isFillable = canFillGrid(xw_next, wordDataBase, wordSlot, wordsInPuzzle)
                        
                        if isFillable:
                            fit_words.append(word)
        else:
            for word, _ in trie.items(prefix=wordCompare[0]):
                if matches_word(word, wordCompare):
                    xw_next = update_xw(xw, wordSlot, word)
                    isFillable = canFillGrid(xw_next, wordDataBase, wordSlot, wordsInPuzzle)
                    
                    if isFillable:
                        fit_words.append(word)


        return fit_words


    def sort_list(fit_words, xw, wordSlot, numWords, wordsInPuzzle):
        #for each word in list
            #for each crossing letter in word, call make list function (make new function that only gets number of words and doesn't store them)
                #listScore.append(len(list)/numWords[index]*lencrossingWord)
            #mean(listScore)
        #sort list based on score
        

        #need to add if statement if word is filled
        listScore = []


            
        for i in range(len(fit_words)): #loop through words list
            test_word = fit_words[i]
            xw_next = deepcopy(xw)
            xw_next = update_xw(xw_next, wordSlot, test_word)
            
            for j in range(len(wordSlot)-4):    #loop through crossing words
                slot = wordSlot[j+4]
                lenIndex = slot[3]-3
                fit_list = make_list(xw_next, slot, lenIndex, wordsInPuzzle)
                if fit_list == -1: #if word is already filled
                    fitScore = 1
                else:
                    fitScore = len(fit_list)/numWords[lenIndex]
                score = fitScore*slot[3]
                listScore.append(score)
                            
                fit_words[i] = [test_word, np.mean(listScore)]
        sorted_list = sorted(fit_words, key=lambda x: x[1], reverse=True)
        sorted_list = [sublist for sublist in sorted_list if sublist[1] != -1]
        return  sorted_list



    '''
        def matches_word(word, wordCompare):
            for w, l in zip(word, wordCompare):
                if l != ' ' and w != l:
                    return False
            return True
        
        fit_words = []
        wordCompare = define_word(xw, wordSlot)

        if wordCompare[0] == ' ':
            for letter in string.ascii_uppercase:
                prefix = letter
                for word, _ in trie.items(prefix=prefix):
                    if matches_word(word, wordCompare):
                        fit_words.append(word)
        else:
            for word, _ in trie.items(prefix=wordCompare[0]):
                if matches_word(word, wordCompare):
                    fit_words.append(word)
        return fit_words
    '''

    # Function to define a word
    def define_word(xw, wordSlot):
        #wordSlot is [row,col,direction,length]
        length = wordSlot[3]
        row = wordSlot[0]
        col = wordSlot[1]
        direc = wordSlot[2]
        wordFrame = [' '] * length
        for i in range(length):
            if direc == 1:
                wordFrame[i] = xw[row][col+i]  # across
            else:
                wordFrame[i] = xw[row+i][col]  # down
                
        return wordFrame


    # Function to update the crossword grid
    def update_xw(xw_next, wordSlot, wordInput):
        row = wordSlot[0]
        col = wordSlot[1]
        direc = wordSlot[2]
        length = wordSlot[3]
        
        for i in range(length):
            if direc == 1:
                xw_next[row][col+i] = wordInput[i]  # across
            else:
                xw_next[row+i][col] = wordInput[i]  # down\
        return xw_next



    def canFillGrid(xw_next, wordDataBase, wordSlot, puzzleWords):
        
        for crossingIndex in range(len(wordSlot)-4):
            wordSlotCrossing = deepcopy(wordSlot[crossingIndex + 4])
            wordCompare = define_word(xw_next, wordSlotCrossing)
            #print(puzzleWords)
            if wordCompare in puzzleWords:
                continue
            lengthIndex = wordSlotCrossing[3]-3
            trie_corr_length = wordDataBase[lengthIndex]
            if not is_match(trie_corr_length, wordCompare):
                return False
        return True


    def is_match(trie, letters):
        def matches_word(word, letters):
            for w, l in zip(word, letters):
                if l != ' ' and w != l:
                    return False
            return True

        if letters[0] == ' ':
            for letter in string.ascii_uppercase:
                prefix = letter
                for word, _ in trie.items(prefix=prefix):
                    if matches_word(word, letters):
                        return True
        else:
            for word, _ in trie.items(prefix=letters[0]):
                if matches_word(word, letters):
                    return True
        return None


    return recursive_solve(xw, 0, wordsInPuzzle, lastPrint)
