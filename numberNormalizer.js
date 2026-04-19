const words = {
    zero:0,
    uno:1,
    una:1,
    due:2,
    tre:3,
    quattro:4,
    cinque:5,
    sei:6,
    sette:7,
    otto:8,
    nove:9,
    dieci:10,
    venti:20,
    trenta:30,
    quaranta:40,
    cinquanta:50,
    sessanta:60,
    settanta:70,
    ottanta:80,
    novanta:90,
    cento:100
  };
  
  function normalizeNumbers(text){
  
    let t=text.toLowerCase();
  
    Object.keys(words).forEach(w=>{
      const regex=new RegExp(`\\b${w}\\b`,"g");
      t=t.replace(regex,words[w]);
    });
  
    return t;
  
  }
  
  module.exports={normalizeNumbers};