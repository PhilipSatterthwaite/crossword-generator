import os
from pytrie import StringTrie

def gen_wordlists(min_usage, min_year):
    folder_path = r"C:\Users\psatt\Desktop\Fun Projects\Crossword Generator\compileWords\SortedWords"

    numWords = []

    wordDataBase = []
    wordDataBase_list = []
    for i in range(3,22):
        file_name =  f"len{i}.txt"
        file_path = os.path.join(folder_path,file_name)
        with open(file_path, "r", encoding="utf-8") as file:
            lines = file.readlines()
        numWords.append(len(lines))
        
        
        trie = StringTrie()
        listedWords = []

        filtered_lines = sorted(
            [
                line for line in lines
                if int(line.split()[1]) >= min_usage and int(line.split()[2]) >= min_year
            ],
            key=lambda x: int(x.split()[1]),  # Sort by the second element (usage)
            reverse = True
        )
        for line in filtered_lines:
            line_data = line.split()
            word = line_data[0]
            score = int(line_data[1])
            trie[word] = score
            listedWords.append(word)
    
        wordDataBase_list.append(listedWords)
        wordDataBase.append(trie)
    return numWords, wordDataBase_list, wordDataBase