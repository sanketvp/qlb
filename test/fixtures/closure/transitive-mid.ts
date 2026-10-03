export const y = 1;
const spec = './leaf';
void import(spec);
void require('./' + 'leaf');
void import(`./${'leaf'}`);
