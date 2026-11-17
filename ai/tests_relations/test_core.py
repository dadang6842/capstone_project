import math
import unittest
from knowledge_relations.core import byte_parts,make_chunks,load_documents,compare_documents,build_graph


def docs(ids):
    return load_documents({'result':{'documents':[
        {'artifactId':aid,'version':1,'status':'adopted','title':aid,'content':'본문 '+aid} for aid in ids]}})


class CoreTests(unittest.TestCase):
    def test_original_substrings_and_coverage(self):
        text='한글🙂 abc\n'*1500
        rows=docs(['a']);rows[0]['content']=text
        chunks=make_chunks(rows)
        covered=set()
        for chunk in chunks:
            self.assertEqual(text[chunk['start']:chunk['end']],chunk['body'])
            self.assertLessEqual(len(chunk['text'].encode()),4602)
            covered.update(range(chunk['start'],chunk['end']))
        self.assertEqual(covered,set(range(len(text))))
        self.assertEqual(sum(c['weight'] for c in chunks),len(text.encode()))

    def test_addition_displaces_edge_and_removal_restores(self):
        def graph(ids,angles):
            rows=docs(ids);chunks=make_chunks(rows)
            vectors=[[math.cos(a),math.sin(a)] for a in angles]
            pairs=compare_documents(rows,chunks,vectors)
            return build_graph(rows,pairs,threshold=.5,neighbors=1,mode='mutual')
        def keys(g):return {tuple(sorted((e['a'],e['b']))) for e in g['edges']}
        baseline=graph(['a','b','c'],[0,.2,1.2])
        added=graph(['a','b','c','e'],[0,.2,1.2,.05])
        self.assertIn(('a','b'),keys(baseline))
        self.assertNotIn(('a','b'),keys(added))
        self.assertIn(('a','e'),keys(added))
        self.assertEqual(keys(baseline),keys(graph(['a','b','c'],[0,.2,1.2])))

    def test_no_forced_link_or_transitive_completion(self):
        rows=docs(['a','b','c'])
        pairs=[{'a':'a','b':'b','similarity':.9},{'a':'b','b':'c','similarity':.9},
               {'a':'a','b':'c','similarity':.1}]
        g=build_graph(rows,pairs,threshold=.5,neighbors=2)
        self.assertEqual(len(g['edges']),2)
        g=build_graph(rows,pairs,threshold=.99,neighbors=2)
        self.assertEqual(len(g['nodes']),3)
        self.assertEqual(g['counts']['isolates'],3)

    def test_mutual_and_union(self):
        rows=docs(['a','b','c'])
        pairs=[{'a':'a','b':'b','similarity':.9},{'a':'b','b':'c','similarity':.8},
               {'a':'a','b':'c','similarity':.7}]
        self.assertEqual(build_graph(rows,pairs,neighbors=1,mode='mutual')['counts']['edges'],1)
        self.assertEqual(build_graph(rows,pairs,neighbors=1,mode='union')['counts']['edges'],2)

    def test_single_and_empty(self):
        self.assertEqual(build_graph([],[])['counts']['documents'],0)
        self.assertEqual(build_graph(docs(['a']),[])['counts']['isolates'],1)


if __name__=='__main__':unittest.main()
