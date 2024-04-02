# functino to make a list of words (x,y,direction,length) from a grid
from copy import copy, deepcopy


   
    
def make_word_list(grid, seed):
    wordslist = []
    word = []
    wordsInPuzzle = []
    for row in range(len(grid)):    #loop through rows
        for col in range(len(grid[0])):    #loop through cols
            #go through each cell
            #if "■" go next
            #else check across
                #is there a non black square before it
                #loop through to find where the next black square is
        
            if grid[row][col] == '■':   #no word if square is black
                continue

            #define across word
            if col == 0 or grid[row][col-1] == '■':
                direc = 1
                length = 1
                
                while col+length < len(grid[0]) and grid[row][col+length] != '■':
                    length = length + 1
                    
                word = [row,col,direc,length]
                if all(letter != ' ' and letter != '■' for letter in define_word(grid, word)):
                    wordsInPuzzle.append(define_word(grid,word))
                wordslist = wordslist + [word]

            #define down word
            if row == 0 or grid[row-1][col] == '■':
                direc = 2
                length = 1
                
                while row+length < len(grid) and grid[row+length][col] != '■':
                    length = length + 1
                word = [row,col,direc,length]
                if all(letter != ' ' and letter != '■' for letter in define_word(grid, word)):
                    wordsInPuzzle.append(define_word(grid,word))
                wordslist = wordslist + [word]

    
    #order list
    '''
    downacross = 2
    wordlistOrdered = deepcopy(wordslist)
    didfinish = True
    for i in range(len(wordlistOrdered)):
        
        if didfinish:
            if downacross == 1:
                downacross = 2
            else:
                downacross = 1
            
            for j in range(len(wordslist)):
                if wordslist[j][2] == downacross:
                    wordlistOrdered[i] = deepcopy(wordslist[j])
                    wordslist[j][2] = 0
                    break
                if j == len(wordslist)-1:
                    
                    didfinish = False
                    
                    
        if didfinish == False:
           
            for k in range(len(wordslist)):
                if wordslist[k][2] != 0:
                    wordlistOrdered[i] = deepcopy(wordslist[k])
                    wordslist[k][2] = 0
                    break
    '''


    
    #add word crossings to list
    wordsAndCrossings = deepcopy(wordslist)
   
    for i in range(len(wordslist)):   #add crossing words to list
    #for i in range(1,2):
        wordEdit = wordslist[i]
        row = wordEdit[0]
        col = wordEdit[1]
        direc = wordEdit[2]
        length = wordEdit[3]
        
        if direc == 1:  #across words
            for colIndex in range(col, col+length):  #loop through columns in word

                crossingIndex = row
                while crossingIndex != 0 and grid[crossingIndex-1][colIndex] != '■': #go backward to find start of crossing word
                    crossingIndex -= 1

                #find word where starting index is crossingIndex, colIndex
                found_element = None
                for j in range(len(wordsAndCrossings)):
                    sublist = deepcopy(wordsAndCrossings[j])
                    
                    if sublist[0] == crossingIndex and sublist[1] == colIndex and sublist[2] == 2:
                        found_element = deepcopy(sublist)
                        break
                wordEdit.append(found_element)
                
        else:
            for rowIndex in range(row, row+length):

                crossingIndex = col
                while crossingIndex != 0 and grid[rowIndex][crossingIndex-1] != '■': #go backward to find start of crossing word
                    crossingIndex -= 1
                    
                
                #find word where starting index is crossingIndex, colIndex
                found_element = None
                for j in range(len(wordsAndCrossings)):
                    sublist = deepcopy(wordsAndCrossings[j])
                
                    
                    if sublist[0] == rowIndex and sublist[1] == crossingIndex and sublist[2] == 1:
                        found_element = deepcopy(sublist)
                        break
                wordEdit.append(found_element)


    '''
    #order list: next word is first available crossing of last solved word
    seedWord = deepcopy(wordslist[0])
                
    wordlistOrdered = deepcopy(wordslist)
    wordslistCopy = deepcopy(wordslist)
    didfinish = True
    usedSlots = [deepcopy(seedWord[:4])]
    wordlistOrdered[0] = deepcopy(seedWord)
    for i in (range(len(wordslistCopy)-1)):    #loops through list to make new list ,len(wordslistCopy)
        workingWord = deepcopy(wordlistOrdered[i])
        if didfinish == True:
            for j in range(4,len(workingWord)): #loops through crossing words
                if any(workingWord[j] == slot for slot in usedSlots):
                    didfinish = False #false if end of loop is reached and no word matches
                    continue
                else:
                    didfinish = True # true because found a next word
                    usedSlots.append(deepcopy(workingWord[j]))

                    for k in range(len(wordslistCopy)): #find word that starts with workingWord[j]
                        if workingWord[j] == wordslistCopy[k][:4]:
                            wordlistOrdered[i+1] = deepcopy(wordslistCopy[k])
                            break
                    break

        if didfinish ==  False:   #sets new seed at next available word (could be better)
            for m in reversed(range(len(wordslistCopy))):
                nextWord = deepcopy(wordslistCopy[m])
                if any(nextWord[:4] == slot for slot in usedSlots):
                    continue
                else:
                    didfinish = True # true because found a next word
                    usedSlots.append(deepcopy(nextWord[:4]))
                    wordlistOrdered[i+1] = deepcopy(nextWord)
                    break
    '''

    #order list: snake from middle around grid
    #seedSquare = [7,7]
    #snake = [[7,7],[6,6],[5,5],[4,4],[3,3],[2,2],[1,1],[0,0],[3,5],[2,6],[1,7],[0,8],[4,9],[3,10],[2,11],[1,12],\
    #         [0,13],[0,14],[6,12],[7,13],[8,14],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[11,9],[12,8],[13,7],[14,6],\
    #         [10,5],[11,4],[12,3],[13,2],[14,1],[14,0],[8,2],[7,1],[6,0]]

    
    snake = deepcopy(seed)
    canContinue = True
    isDone = False
    index = -1
    while not isDone:
    #for i in range(2):
        index += 1
        #go up and left, then up and right, then down and right, then down and left
        if canContinue:
            index = len(snake)-1
        currentLoc = deepcopy(snake[index])
        if canSnake(grid, [currentLoc[0]-1, currentLoc[1]-1], snake, 1, 1):
            nextLoc = [currentLoc[0]-1, currentLoc[1]-1] #up and left
            snake.append(deepcopy(nextLoc))
            canContinue = True

        elif canSnake(grid, [currentLoc[0]-1, currentLoc[1]+1], snake, 1, -1):
            nextLoc = [currentLoc[0]-1, currentLoc[1]+1] #up and right
            snake.append(deepcopy(nextLoc))
            canContinue = True

        elif canSnake(grid, [currentLoc[0]+1, currentLoc[1]+1], snake, -1, -1):
            nextLoc = [currentLoc[0]+1, currentLoc[1]+1] #down and right
            snake.append(deepcopy(nextLoc))
            canContinue = True
            
        elif canSnake(grid, [currentLoc[0]+1, currentLoc[1]-1], snake, -1, 1):
            nextLoc = [currentLoc[0]+1, currentLoc[1]-1] #down and left
            snake.append(deepcopy(nextLoc))
            canContinue = True
            
        else:
            canContinue = False
        
        #if there are no options, go to previous word in the grid

        
        

        if not canContinue:
            if index == -1:
                isDone = True
            else:
                index -= 2
    
    #for row in snake:
    #    print(row)   

    #for row in wordslist:
    #    print(row)
    #print()

    wordlistOrdered = []
    usedSlots = [[]]
    for i in range(len(snake)): #loop through squares
        
        for j in range(len(wordslist)): #find across word that crosses
            #if across and row is correct and start loc is <= col and end loc >= col
            if wordslist[j][2] == 1 and wordslist[j][0] == snake[i][0] and wordslist[j][1] <= snake[i][1] and wordslist[j][1] + wordslist[j][3] -1 >= snake[i][1]: 
               
                if any(wordslist[j][:4] == slot for slot in usedSlots): #if word is already used, break
                    break
                else:
                    usedSlots.append(deepcopy(wordslist[j][:4]))
                    wordlistOrdered.append(deepcopy(wordslist[j]))
                    #print(wordslist[j][:4])
                break
        
        for k in range(len(wordslist)): #find down word that crosses
            #if down and col is correct and start loc is <= row and end loc >= row
            if wordslist[k][2] == 2 and wordslist[k][1] == snake[i][1] and wordslist[k][0] <= snake[i][0] and wordslist[k][0] + wordslist[k][3] -1 >= snake[i][0]: 
                if any(wordslist[k][:4] == slot for slot in usedSlots): #if word is already used, break
                    break
                else:
                    
                    usedSlots.append(deepcopy(wordslist[k][:4]))
                    wordlistOrdered.append(deepcopy(wordslist[k]))
                    #print(wordslist[k][:4])
                break
        
        #loop through words to find first across word to cross through square
        #add word index to usedSlots
        #add word to list
        
        
        #loop through words to find first down """"
            
        





    
        

        
    
    return wordlistOrdered, wordsInPuzzle

def canSnake(grid, space, snake, hor, ver):
    #cannot be black square, cannot cut diagonally across black square, cannot be an already filled word, cannot be out of grid
    
    if space[0] > len(grid)-1 or space[1] > len(grid[0])-1:
        return False

    if space[0] < 0 or space[1] < 0:
        return False    

    if grid[space[0]+hor][space[1]] == '■' and grid[space[0]][space[1]+ver] == '■':
        return False
        
    if grid[space[0]][space[1]] == '■':
        return False
        
    if any(space == slot for slot in snake):
        return False
        
    
        
    return True





        

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










    
